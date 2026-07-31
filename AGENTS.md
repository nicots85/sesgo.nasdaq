# Reglas del proyecto sesgo.nasdaq

## Workflow principal

1. **Primero local, siempre local.** Todo cambio se prueba en `http://localhost:3005` (server.js) antes de considerar un deploy.
2. **Nunca deployar trabajo inacabado.** Si falta una funcionalidad, un fix, o una prueba, no se sube a Vercel.
3. **Desplegar solo cuando el usuario confirme 100% de finalización.** El deploy es la última acción, nunca la primera.

## Orden de verificación antes de deploy

1. Sintaxis: `node --check` en todos los archivos tocados.
2. Tests: `node tests/test_box.js` (si aplica).
3. Local: abrir `http://localhost:3005` y verificar que todo funciona.
4. Capturador real: `node -e "require('./api/box-capture').captureToday().then(r => console.log(JSON.stringify(r, null, 2)))"` — solo en horario de mercado.
5. Deploy a Vercel.

## Despliegue

- Comando: `npx vercel --prod`
- Proyecto: `technostore/nasdaq`
- URL: `https://nasdaq-alpha.vercel.app`
- Crons verificar con: `npx vercel cron ls`

## API keys

- `.env` (local): `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, `GROQ_API_KEY`
- `.env` está en `.gitignore` — nunca subirlo.
- En Vercel: Settings → Environment Variables (Production).

## Estructura del repo

```
nasdaq/
├── api/           → endpoints (bias, correlations, news, market, cron, box-capture)
├── lib/           → utilidades (stats, groq, rss, box)
├── data/          → archivos semilla (historical.json, box_history.json)
├── tests/         → tests (test_box.js)
├── index.html     → frontend principal
├── server.js      → servidor de desarrollo local (puerto 3005)
├── vercel.json    → config Vercel (crons)
├── package.json   → dependencias
└── .env           → claves API (local only, gitignored)
```