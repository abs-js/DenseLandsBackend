"use strict";
/**
 * DenseLands MP — primeira tentativa (localhost).
 * DB em JSON (data/db.json). Depois troca por Postgres/Mongo sem mudar o protocolo.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 8787);
const DATA = path.join(__dirname, "data");
const DB_FILE = path.join(DATA, "db.json");
const PUBLIC = path.join(__dirname, "public");

const REPORTS = {
  1: "Quebra de regras do servidor",
  2: "Cheating",
  3: "Tóxico",
  4: "Scam",
  5: "Construções inadequadas",
  6: "Outro",
};
const SCAM_NOTE =
  "você deve se responsabilizar pelo que perdeu. Embora isso, o admin recebeu este aviso e ele decidirá";

const SLOT_DEFS = [
  { key: "1", name: "Sala 1", rotating: false },
  { key: "2", name: "Sala 2", rotating: false },
  { key: "3", name: "Sala 3", rotating: false },
  { key: "4", name: "Sala 4", rotating: true },
  { key: "5", name: "Sala 5", rotating: true },
];
const SLEEP_MS = 60 * 60 * 1000;

function uid(n) { return crypto.randomBytes(n || 4).toString("hex"); }
function hashPass(pass, salt) {
  return crypto.scryptSync(String(pass), salt, 32).toString("hex");
}
function now() { return Date.now(); }

function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    return { users: {}, rooms: {}, reports: [], sessions: {} };
  }
}
function saveDb() {
  if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

let db = loadDb();
function blankMap() { return { seed: null, chunks: {}, edits: [], animals: [], drops: {}, spawn: null, time: 20 }; }

function editKey(e) {
  if (e.kind === "animal") return "an:" + e.aid;
  return String(e.kind) + ":" + e.tx + "," + e.ty;
}
function compactEdits(list) {
  const m = new Map();
  for (const e of list || []) m.set(editKey(e), e);
  return [...m.values()];
}
function ensureSlots() {
  if (!db.rooms) db.rooms = {};
  for (const s of SLOT_DEFS) {
    if (!db.rooms[s.key]) {
      db.rooms[s.key] = {
        key: s.key,
        name: s.name,
        seed: null,
        admin: null,
        passHash: null,
        banned: {},
        map: blankMap(),
        createdAt: now(),
        lastOccupied: 0,
        rotating: s.rotating,
      };
    } else {
      db.rooms[s.key].name = s.name;
      db.rooms[s.key].rotating = s.rotating;
    }
  }
  Object.keys(db.rooms).forEach((k) => {
    if (!SLOT_DEFS.some((s) => s.key === k)) delete db.rooms[k];
  });
}
function onlineCount(key) {
  return [...sockets.values()].filter((s) => s.roomKey === key).length;
}
function resetRoom(r) {
  r.seed = null;
  r.admin = null;
  r.map = blankMap();
  r.banned = {};
  r.lastOccupied = 0;
}
function tickSleep() {
  for (const s of SLOT_DEFS) {
    if (!s.rotating) continue;
    const r = db.rooms[s.key];
    if (!r || !r.seed) continue;
    if (onlineCount(s.key) > 0) {
      r.lastOccupied = now();
      continue;
    }
    const idle = r.lastOccupied ? now() - r.lastOccupied : SLEEP_MS + 1;
    if (idle >= SLEEP_MS) resetRoom(r);
  }
}
ensureSlots();
setInterval(saveDb, 8000);
setInterval(tickSleep, 15000);

const sockets = new Map(); // ws -> session

function publicRoom(r) {
  const online = onlineCount(r.key);
  let sleepLeft = null;
  if (r.rotating && r.seed && online === 0 && r.lastOccupied) {
    sleepLeft = Math.max(0, SLEEP_MS - (now() - r.lastOccupied));
  }
  return {
    key: r.key,
    name: r.name,
    hasPass: false,
    seed: r.seed,
    admin: r.admin,
    online,
    rotating: !!r.rotating,
    empty: !r.seed,
    sleepLeft,
    createdAt: r.createdAt,
  };
}

function json(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 2e6) req.destroy(); });
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); }
    });
  });
}

function userFromAuth(req) {
  const h = req.headers.authorization || "";
  const token = h.replace(/^Bearer\s+/i, "");
  const sess = db.sessions[token];
  if (!sess) return null;
  const u = db.users[sess.user];
  return u ? { token, user: u } : null;
}

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
};

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Headers": "Content-Type, Authorization" });
    return res.end();
  }

  if (req.url === "/health") {
    return json(res, 200, { ok: true, name: "DenseLands MP", rooms: Object.keys(db.rooms).length });
  }

  if (req.method === "POST" && req.url === "/api/register") {
    const b = await readBody(req);
    const name = String(b.user || b.name || "").trim().slice(0, 16);
    const pass = String(b.pass || "");
    if (!/^[a-zA-Z0-9_]{3,16}$/.test(name)) return json(res, 400, { error: "Usuário: 3-16 letras, números ou _" });
    if (pass.length < 4) return json(res, 400, { error: "Senha curta demais." });
    const key = name.toLowerCase();
    if (db.users[key]) return json(res, 409, { error: "Esse nome já existe." });
    const salt = uid(8);
    db.users[key] = { name, salt, hash: hashPass(pass, salt), createdAt: now(), bannedFrom: {}, xp: 0, level: 1, ach: {}, found: {} };
    const token = uid(16);
    db.sessions[token] = { user: key, at: now() };
    saveDb();
    return json(res, 200, { token, name, xp: 0, level: 1, ach: {}, found: {} });
  }

  if (req.method === "POST" && req.url === "/api/login") {
    const b = await readBody(req);
    const key = String(b.user || b.name || "").trim().toLowerCase();
    const u = db.users[key];
    if (!u || u.hash !== hashPass(b.pass || "", u.salt)) return json(res, 401, { error: "Usuário ou senha errados." });
    const token = uid(16);
    db.sessions[token] = { user: key, at: now() };
    saveDb();
    u.xp = u.xp || 0; u.ach = u.ach || {}; u.found = u.found || {};
    return json(res, 200, { token, name: u.name, xp: u.xp, level: u.level || 1, ach: u.ach, found: u.found });
  }

  if (req.method === "GET" && req.url === "/api/me") {
    const auth = userFromAuth(req);
    if (!auth) return json(res, 401, { error: "Entre na conta." });
    const u = auth.user;
    return json(res, 200, { name: u.name, xp: u.xp || 0, level: u.level || 1, ach: u.ach || {}, found: u.found || {} });
  }

  if (req.method === "POST" && req.url === "/api/profile") {
    const auth = userFromAuth(req);
    if (!auth) return json(res, 401, { error: "Entre na conta." });
    const b = await readBody(req);
    const u = auth.user;
    u.ach = Object.assign({}, u.ach || {}, b.ach || {});
    u.found = Object.assign({}, u.found || {}, b.found || {});
    u.xp = Math.max(u.xp || 0, Number(b.xp) || 0);
    let lv = 1, left = u.xp;
    const need = (l) => 20 + Math.max(0, l - 1) * 15;
    while (left >= need(lv) && lv < 99) { left -= need(lv); lv++; }
    u.level = lv;
    saveDb();
    return json(res, 200, { name: u.name, xp: u.xp, level: u.level, ach: u.ach, found: u.found });
  }

  if (req.method === "GET" && req.url.startsWith("/api/rooms/")) {
    const key = decodeURIComponent(req.url.split("/").pop());
    const r = db.rooms[key];
    if (!r) return json(res, 404, { error: "Sala não existe." });
    return json(res, 200, { room: publicRoom(r) });
  }

  if (req.method === "POST" && req.url === "/api/rooms") {
    return json(res, 400, { error: "Não se criam salas. Existem só a 1, 2, 3, 4 e 5." });
  }

  if (req.method === "GET" && req.url === "/api/rooms") {
    tickSleep();
    ensureSlots();
    return json(res, 200, { rooms: SLOT_DEFS.map((s) => publicRoom(db.rooms[s.key])) });
  }

  if (req.method === "GET" && req.url.startsWith("/api/reports")) {
    const auth = userFromAuth(req);
    if (!auth) return json(res, 401, { error: "Entre na conta." });
    const q = new URL(req.url, "http://x");
    const roomKey = q.searchParams.get("room");
    const list = db.reports.filter((r) => !roomKey || r.room === roomKey);
    const adminOk = !roomKey || (db.rooms[roomKey] && db.rooms[roomKey].admin === auth.user.name);
    if (!adminOk) return json(res, 403, { error: "Só o admin vê reports da sala." });
    return json(res, 200, { reports: list.slice(-80) });
  }

  // static
  let file = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const full = path.normalize(path.join(PUBLIC, file));
  if (full.startsWith(PUBLIC) && fs.existsSync(full) && fs.statSync(full).isFile()) {
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "text/plain" });
    return fs.createReadStream(full).pipe(res);
  }
  json(res, 404, { error: "not found" });
});

const wss = new WebSocketServer({ server, path: "/ws" });

function peers(roomKey) {
  return [...sockets.entries()].filter(([, s]) => s.roomKey === roomKey);
}
function send(ws, obj) {
  if (ws.readyState === 1) try { ws.send(JSON.stringify(obj)); } catch {}
}
function broadcast(roomKey, obj, except) {
  peers(roomKey).forEach(([ws, s]) => { if (ws !== except) send(ws, obj); });
}
function roster(roomKey) {
  return peers(roomKey).map(([, s]) => ({
    name: s.name, x: s.x, y: s.y, hp: s.hp, admin: s.adminMode, dirx: s.dirx, diry: s.diry,
    skin: s.skin, shirt: s.shirt, hair: s.hair,
  }));
}

wss.on("connection", (ws) => {
  sockets.set(ws, {
    name: null, roomKey: null, x: 0, y: 0, hp: 20, maxHp: 20,
    dirx: 0, diry: 1, adminMode: false, muted: {}, lastPos: 0,
  });
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    handle(ws, sockets.get(ws), msg);
  });
  ws.on("close", () => {
    const s = sockets.get(ws);
    if (s && s.roomKey && s.name) {
      broadcast(s.roomKey, { type: "left", name: s.name }, ws);
      const r = db.rooms[s.roomKey];
      if (r) r.lastOccupied = now();
    }
    sockets.delete(ws);
  });
});

function handle(ws, s, msg) {
  if (!msg || typeof msg.type !== "string") return;
  if (msg.type === "auth") {
    const sess = db.sessions[msg.token];
    if (!sess || !db.users[sess.user]) return send(ws, { type: "error", msg: "Sessão inválida." });
    s.name = db.users[sess.user].name;
    s.userKey = sess.user;
    return send(ws, { type: "authed", name: s.name });
  }
  if (!s.name) return send(ws, { type: "error", msg: "Faça login." });

  if (msg.type === "join") {
    const key = String(msg.key || "").replace(/[^1-5]/g, "").slice(0, 1);
    const room = db.rooms[key];
    if (!room) return send(ws, { type: "error", msg: "Use a sala 1, 2, 3, 4 ou 5." });
    if (room.banned[s.name.toLowerCase()]) return send(ws, { type: "error", msg: "Você está banido desta sala." });
    tickSleep();
    if (!room.seed) {
      const seed = Number(msg.seed);
      room.seed = Number.isFinite(seed) && seed > 0 ? (seed | 0) : (1 + Math.random() * 99998 | 0);
      room.admin = s.name;
      room.map.seed = room.seed;
      room.lastOccupied = now();
      saveDb();
    }
    s.roomKey = key;
    s.x = (room.map.spawn && room.map.spawn.x) || 8 * 40;
    s.y = (room.map.spawn && room.map.spawn.y) || 8 * 40;
    s.hp = 20; s.adminMode = false;
    room.lastOccupied = now();
    room.map.edits = compactEdits(room.map.edits || []);
    send(ws, { type: "joined", room: publicRoom(room), map: room.map, you: s.name, admin: room.admin === s.name, players: roster(key), noPvp: room.key === "3" || room.key === "4" });
    broadcast(key, { type: "joinedPeer", player: { name: s.name, x: s.x, y: s.y, hp: s.hp, skin: s.skin, shirt: s.shirt, hair: s.hair } }, ws);
    broadcast(key, { type: "chat", from: "sistema", text: s.name + " entrou.", sys: true });
    return;
  }

  if (!s.roomKey) return;
  const room = db.rooms[s.roomKey];
  if (!room) return;
  const isAdmin = room.admin === s.name;

  if (msg.type === "pos") {
    const t = now();
    if (t - s.lastPos < 40) return;
    s.lastPos = t;
    s.x = Number(msg.x) || 0;
    s.y = Number(msg.y) || 0;
    s.dirx = Number(msg.dirx) || 0;
    s.diry = Number(msg.diry) || 1;
    s.skin = msg.skin || s.skin;
    s.shirt = msg.shirt || s.shirt;
    s.hair = msg.hair || s.hair;
    broadcast(s.roomKey, { type: "pos", name: s.name, x: s.x, y: s.y, dirx: s.dirx, diry: s.diry, hp: s.hp, admin: s.adminMode, skin: s.skin, shirt: s.shirt, hair: s.hair }, ws);
    return;
  }

  if (msg.type === "hit") {
    if (room.key === "3" || room.key === "4") {
      return send(ws, { type: "sys", text: "PvP desligado nesta sala." });
    }
    const target = String(msg.name || "");
    const spawn = room.map.spawn;
    const inBlue = (os) => spawn && Math.hypot((os.x || 0) - spawn.x, (os.y || 0) - spawn.y) < 6 * 40;
    const dmg = Math.max(1, Math.min(16, Number(msg.dmg) || 2));
    peers(s.roomKey).forEach(([ows, os]) => {
      if (os.name !== target) return;
      if (os.adminMode) return;
      if (inBlue(os) || inBlue(s)) return;
      os.hp -= dmg;
      if (os.hp <= 0) {
        os.hp = os.maxHp;
        os.x = 8 * 40; os.y = 8 * 40;
        broadcast(s.roomKey, { type: "death", name: os.name, by: s.name });
        broadcast(s.roomKey, { type: "chat", from: "sistema", text: os.name + " foi derrotado por " + s.name + ".", sys: true });
        send(ows, { type: "respawn", x: os.x, y: os.y, hp: os.hp });
      } else {
        send(ows, { type: "hurt", by: s.name, hp: os.hp, dmg });
      }
    });
    return;
  }

  if (msg.type === "chunk") {
    if (!msg.cx && msg.cx !== 0) return;
    const id = msg.cx + "," + msg.cy;
    room.map.chunks[id] = msg.chunk;
    room.map.time = Number(msg.time) || room.map.time;
    broadcast(s.roomKey, { type: "chunk", cx: msg.cx, cy: msg.cy, chunk: msg.chunk }, ws);
    return;
  }

  if (msg.type === "edit") {
    if (!room.map.edits) room.map.edits = [];
    const edit = {
      kind: String(msg.kind || ""),
      tx: Number(msg.tx), ty: Number(msg.ty),
      hp: msg.hp, id: msg.id, items: msg.items || null,
      aid: msg.aid, ax: msg.ax, ay: msg.ay, akind: msg.akind,
    };
    room.map.edits.push(edit);
    room.map.edits = compactEdits(room.map.edits);
    broadcast(s.roomKey, { type: "edit", from: s.name, ...edit });
    return;
  }

  if (msg.type === "helloSpawn") {
    let x = Number(msg.x) || 320, y = Number(msg.y) || 320;
    if (Math.abs(x) < 80 && Math.abs(y) < 80) { x = x * 40 + 20; y = y * 40 + 20; }
    if (!room.map.spawn || (Math.abs(room.map.spawn.x) < 80 && Math.abs(room.map.spawn.y) < 80)) {
      room.map.spawn = { x, y };
      saveDb();
    }
    send(ws, { type: "spawnPoint", x: room.map.spawn.x, y: room.map.spawn.y });
    return;
  }

  if (msg.type === "drop") {
    if (!room.map.drops) room.map.drops = {};
    const did = String(msg.did || uid(3));
    const drop = { did, id: String(msg.id || "").slice(0, 24), n: Math.max(1, Number(msg.n) || 1), x: Number(msg.x) || 0, y: Number(msg.y) || 0 };
    room.map.drops[did] = drop;
    broadcast(s.roomKey, { type: "drop", ...drop });
    return;
  }

  if (msg.type === "take") {
    if (!room.map.drops) room.map.drops = {};
    const did = String(msg.did || "");
    const drop = room.map.drops[did];
    if (!drop) return send(ws, { type: "takeDenied", did });
    delete room.map.drops[did];
    send(ws, { type: "loot", did, id: drop.id, n: drop.n });
    broadcast(s.roomKey, { type: "taken", did, by: s.name }, ws);
    return;
  }

  if (msg.type === "animals") {
    const list = Array.isArray(msg.list) ? msg.list.slice(0, 40).map((a) => ({
      id: String(a.id || "").slice(0, 24),
      kind: a.kind === "ovelha" ? "ovelha" : "vaca",
      x: Number(a.x) || 0, y: Number(a.y) || 0,
      hp: Number(a.hp) || 6,
      alive: a.alive !== false,
    })) : [];
    room.map.animals = list;
    broadcast(s.roomKey, { type: "animals", list }, ws);
    return;
  }

  if (msg.type === "chat") {
    const text = String(msg.text || "").slice(0, 180);
    if (!text) return;
    if (text.startsWith("/")) return runCmd(ws, s, room, isAdmin, text);
    broadcast(s.roomKey, { type: "chat", from: s.name, text });
    return;
  }
}

function findPeer(roomKey, name) {
  const n = String(name || "").toLowerCase();
  return peers(roomKey).find(([, s]) => s.name.toLowerCase() === n);
}

function runCmd(ws, s, room, isAdmin, line) {
  const parts = line.trim().slice(1).split(/\s+/);
  const cmd = (parts[0] || "").toLowerCase();
  const rest = parts.slice(1);

  if (cmd === "spawn") {
    const sp = room.map.spawn || { x: 320, y: 320 };
    s.x = sp.x; s.y = sp.y;
    send(ws, { type: "tp", x: s.x, y: s.y });
    return send(ws, { type: "sys", text: "Você voltou ao spawn." });
  }

  if (cmd === "filter") {
    const who = rest[0];
    if (!who) return send(ws, { type: "sys", text: "Uso: /filter nome" });
    s.muted[who.toLowerCase()] = !s.muted[who.toLowerCase()];
    return send(ws, { type: "sys", text: s.muted[who.toLowerCase()] ? ("Filtro ligado: " + who) : ("Filtro desligado: " + who) });
  }
  if (cmd === "report") {
    const who = rest[0];
    const code = Number(rest[1]) || 6;
    const reason = REPORTS[code] || REPORTS[6];
    db.reports.push({ at: now(), room: room.key, by: s.name, target: who, code, reason });
    saveDb();
    peers(room.key).forEach(([ows, os]) => {
      if (os.name === room.admin) send(ows, { type: "sys", text: "Report: " + s.name + " → " + who + " (" + reason + ")" });
    });
    if (code === 4) return send(ws, { type: "sys", text: SCAM_NOTE });
    return send(ws, { type: "sys", text: "Report enviado ao admin." });
  }

  if (!isAdmin) return send(ws, { type: "sys", text: "Só o admin usa /" + cmd });

  if (cmd === "players") {
    return send(ws, { type: "sys", text: "Jogadores: " + roster(room.key).map((p) => p.name).join(", ") });
  }
  if (cmd === "tp") {
    const hit = findPeer(room.key, rest[0]);
    if (!hit) return send(ws, { type: "sys", text: "Jogador não está online." });
    s.x = hit[1].x; s.y = hit[1].y;
    send(ws, { type: "tp", x: s.x, y: s.y });
    return send(ws, { type: "sys", text: "Teleportado até " + hit[1].name });
  }
  if (cmd === "kick") {
    const hit = findPeer(room.key, rest[0]);
    if (!hit) return send(ws, { type: "sys", text: "Jogador não está online." });
    send(hit[0], { type: "kicked", reason: "kick do admin" });
    hit[1].roomKey = null;
    try { hit[0].close(); } catch {}
    broadcast(room.key, { type: "chat", from: "sistema", text: rest[0] + " foi kickado.", sys: true });
    return;
  }
  if (cmd === "ban") {
    const name = String(rest[0] || "");
    const k = name.toLowerCase();
    if (!k) return send(ws, { type: "sys", text: "Uso: /ban nome" });
    if (room.banned[k]) {
      delete room.banned[k];
      saveDb();
      return send(ws, { type: "sys", text: name + " desbanido." });
    }
    room.banned[k] = { by: s.name, at: now() };
    saveDb();
    const hit = findPeer(room.key, name);
    if (hit) {
      send(hit[0], { type: "kicked", reason: "ban" });
      hit[1].roomKey = null;
      try { hit[0].close(); } catch {}
    }
    broadcast(room.key, { type: "chat", from: "sistema", text: name + " foi banido.", sys: true });
    return;
  }
  if (cmd === "adm") {
    s.adminMode = !s.adminMode;
    return send(ws, { type: "adm", on: s.adminMode });
  }
  send(ws, { type: "sys", text: "Comandos: /tp /ban /kick /players /adm · jogador: /filter /report" });
}

server.listen(PORT, "0.0.0.0", () => {
  console.log("DenseLands MP em http://localhost:" + PORT);
  console.log("WebSocket em ws://localhost:" + PORT + "/ws");
});
