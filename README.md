# DenseLands Backend

Servidor Node + WebSocket do DenseLands.

## Local

```bash
npm install
node server.js
```

Abre http://localhost:8787

## Deploy (Render / Railway / Koyeb)

Se o **primeiro deploy** rodou com o repositório ainda vazio, a plataforma trava o botão "Retry" às vezes.

Jeito certo:

1. Confirme que `server.js`, `package.json` e `public/` estão no GitHub (já estão).
2. Na plataforma, **não** use só Retry do deploy antigo.
3. Faça um **Manual Deploy** da branch `main`, **ou** apague o serviço e crie outro apontando de novo para `abs-js/DenseLandsBackend`.
4. Comando de start: `npm start` ou `node server.js`.
5. A porta é `process.env.PORT` (a plataforma preenche sozinha).

Site estático do jogo (GitHub Pages):
https://abs-js.github.io/DenseLands/
