# DenseLands Online — 1ª tentativa (localhost)

Não usei a API do jogo de tiro / futebol porque **os dois servidores atuais não têm banco**:
- `abs-js/shot-game` — Socket.IO, tudo na memória
- `abs-js/websocket` — School Soccer WS, rating também na memória

Aqui o “DB” é o arquivo `data/db.json` (contas, salas, mapa, reports). Depois dá para trocar por Postgres sem mudar o protocolo HTTP/WS.

## Subir

```bash
cd denselands-server
npm install
node server.js
```

Abra **http://localhost:8787** em dois navegadores (ou uma aba anônima).

## O que já funciona

- Criar conta / entrar
- Criar sala (quem cria é **admin**) com chave e senha opcional
- Entrar pela lista ou pela chave
- Chat
- PvP (Z no outro jogador) + mensagem de queda + respawn
- Mapa da sala gravado no DB (`rooms[key].map.chunks`)
- Reports para o admin

### Jogador
- `/filter nome` — para de ver o chat dessa pessoa
- `/report nome codigo` — códigos:
  1 regras · 2 cheating · 3 tóxico · 4 scam · 5 construções · 6 outro  
  No **4 (scam)** o aviso é: *você deve se responsabilizar pelo que perdeu. Embora isso, o admin recebeu este aviso e ele decidirá*

### Admin da sala
- `/tp jogador`
- `/ban jogador` (repete para desbanir)
- `/kick jogador`
- `/players`
- `/adm` — invencível + anda mais rápido (nesta 1ª fatia; atravessar blocos entra quando ligar no DenseLands.html)

## Próximo passo

Ligar este mesmo `ws://localhost:8787/ws` no `DenseLands.html` (posições, chunks, PvP e chat). O protocolo já está pronto:

`auth → join → pos / hit / chat / chunk`
