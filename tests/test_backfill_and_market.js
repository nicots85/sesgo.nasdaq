// Pruebas SIN internet: backfill de la caja + reintentos de market.js
const assert = require('assert');
const { buildHistoryFromBars, mergeHistories } = require('../scripts/backfill-box');

// ---- velas sintéticas: 04:00-16:00 NY (EDT = UTC-4) de lunes a viernes ----
function dayBars(y, m, d, breakUp) {
  const bars = [];
  for (let min = 4 * 60; min < 16 * 60; min++) {
    const t = Date.UTC(y, m - 1, d, Math.floor(min / 60) + 4, min % 60);
    let base = 20000;
    if (min >= 9 * 60 + 30) base = breakUp ? 20200 : 19800; // tras las 9:30 rompe arriba o abajo
    bars.push({ t, o: base, h: base + 5, l: base - 5, c: base });
  }
  return bars;
}
let bars = [];
[[2026, 9, 21, true], [2026, 9, 22, false], [2026, 9, 23, true]].forEach(a => bars = bars.concat(dayBars(...a)));
// un sábado con solo 10 velas (fragmento) y "hoy" incompleto
bars = bars.concat(dayBars(2026, 9, 26, true).slice(0, 10));
bars = bars.concat(dayBars(2026, 9, 29, true).slice(0, 200));

const built = buildHistoryFromBars(bars, '2026-09-29');
assert.deepStrictEqual(built.overnight.map(r => r.date), ['2026-09-21', '2026-09-22', '2026-09-23']);
assert.strictEqual(built.overnight[0].breakout, 'alcista');
assert.strictEqual(built.overnight[1].breakout, 'bajista');
assert.strictEqual(built.ib.length, 3);
console.log('OK backfill: 3 días completos, sin hoy ni fragmentos');

// ---- fusión: no duplica, no pisa lo existente, conserva registros sin fecha ----
const existing = { overnight: [{ high: 1 }, { date: '2026-09-22', marca: 'real' }], ib: [{ date: '2026-09-22' }] };
const { history, added } = mergeHistories(existing, built);
assert.strictEqual(added, 2);
assert.strictEqual(history.overnight.length, 4);
assert.strictEqual(history.overnight.find(r => r.date === '2026-09-22').marca, 'real');
assert.ok(!history.overnight[0].date); // el viejo sin fecha queda primero
assert.strictEqual(mergeHistories(history, built).added, 0); // segunda corrida: nada nuevo
console.log('OK fusión: sin duplicados ni pisadas (idempotente)');

// ---- market.js: reintentos ----
const market = require('../api/market');
(async () => {
  const ok = (price) => ({ ok: true, status: 200, json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: price, previousClose: 100, shortName: 'X' } }] } }) });
  const hosts = [];

  // falla 500, luego red caída, luego responde bien -> debe devolver el dato
  let seq = [{ ok: false, status: 500 }, 'net', ok(105)];
  global.fetch = async (url) => { hosts.push(new URL(url).host); const s = seq.shift(); if (s === 'net') throw new Error('red'); return s; };
  let q = await market.fetchQuote('^TEST');
  assert.strictEqual(q.price, 105);
  assert.ok(hosts.includes('query2.finance.yahoo.com'), 'debe probar el segundo servidor');
  console.log('OK market: reintenta y usa el 2º servidor de Yahoo');

  // ahora Yahoo cae del todo -> devuelve el último valor bueno marcado _stale
  seq = null;
  global.fetch = async () => { throw new Error('caído'); };
  const t0 = Date.now();
  q = await market.fetchQuote('^TEST');
  assert.strictEqual(q.price, 105);
  assert.strictEqual(q._stale, true);
  assert.ok(Date.now() - t0 < 9500, 'no debe pasar del tope de tiempo');
  console.log('OK market: con Yahoo caído usa último dato bueno (_stale)');

  // 404 real -> null sin reintentar
  let n = 0;
  global.fetch = async () => { n++; return { ok: false, status: 404 }; };
  assert.strictEqual(await market.fetchQuote('^NOEXISTE'), null);
  assert.strictEqual(n, 1);
  console.log('OK market: 404 no reintenta');
})().catch(e => { console.error('FALLO', e); process.exit(1); });
