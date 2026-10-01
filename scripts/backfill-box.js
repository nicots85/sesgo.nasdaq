#!/usr/bin/env node
/**
 * Llena el historial de la caja overnight con los últimos ~30 días reales del
 * futuro NQ=F (Yahoo entrega velas de 1 minuto solo de los últimos 30 días).
 *
 * Uso (desde la carpeta del proyecto, en TU computadora con internet):
 *   node scripts/backfill-box.js            → actualiza data/box_history.json
 *   node scripts/backfill-box.js --kv       → además fusiona con la base de datos
 *                                             de Vercel (necesita KV_REST_API_URL y
 *                                             KV_REST_API_TOKEN: `npx vercel env pull`)
 *   node scripts/backfill-box.js --dry      → solo muestra qué agregaría, no escribe
 *
 * Es seguro correrlo varias veces: no duplica días (deduplica por fecha) y NUNCA
 * pisa un día ya registrado por el capturador diario.
 */
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const box = require('../lib/box');

const SYMBOL = 'NQ=F';
const CHUNK_DAYS = 7;      // Yahoo limita las velas de 1 min a 7 días por pedido
const MAX_BACK_DAYS = 29;  // ...y a los últimos 30 días en total
const HIST_PATH = path.join(__dirname, '..', 'data', 'box_history.json');

async function fetchChunk(p1, p2) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(SYMBOL)}?interval=1m&includePrePost=true&period1=${p1}&period2=${p2}`;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (res.ok) {
        const r = (await res.json())?.chart?.result?.[0];
        if (!r || !r.timestamp) return [];
        const q = r.indicators.quote[0];
        const bars = [];
        for (let k = 0; k < r.timestamp.length; k++) {
          if (q.high[k] == null || q.low[k] == null || q.close[k] == null) continue;
          bars.push({ t: r.timestamp[k] * 1000, o: q.open[k], h: q.high[k], l: q.low[k], c: q.close[k] });
        }
        return bars;
      }
    } catch (e) { /* reintenta */ }
    await new Promise(r => setTimeout(r, 1000 * (i + 1)));
  }
  throw new Error(`Yahoo no respondió para el tramo ${new Date(p1 * 1000).toISOString()}`);
}

async function fetchLast30Days() {
  const now = Math.floor(Date.now() / 1000);
  const byT = new Map();
  for (let back = 0; back < MAX_BACK_DAYS; back += CHUNK_DAYS) {
    const p2 = now - back * 86400;
    const p1 = now - Math.min(back + CHUNK_DAYS, MAX_BACK_DAYS) * 86400;
    for (const b of await fetchChunk(p1, p2)) byT.set(b.t, b);
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/** Convierte velas de 1 min (varios días) en registros diarios listos para el historial. */
function buildHistoryFromBars(bars, todayKey) {
  const ov = box.runBoxBacktest(bars, 'overnight', box.PREMARKET_START, box.PREMARKET_END, box.MIN_BARS_PREMARKET);
  const ib = box.runBoxBacktest(bars, 'ib', box.IB_START, box.IB_END, box.MIN_BARS_IB);
  const ibByDate = new Map(ib.map(r => [r.date, r]));
  const out = { overnight: [], ib: [] };
  for (const o of ov) {
    // Excluir: hoy (sesión incompleta), fines de semana / fragmentos sin caja, y días sin sesión completa
    if (o.date >= todayKey) continue;
    if (o.nBars === 0) continue;
    const i = ibByDate.get(o.date);
    if (!i || i.nBars === 0) continue;
    out.overnight.push(o);
    out.ib.push(i);
  }
  return out;
}

/** Une historiales por fecha. Lo ya existente tiene prioridad sobre lo nuevo. */
function mergeHistories(existing, incoming) {
  const merge = (a, b) => {
    const seen = new Set(a.filter(r => r.date).map(r => r.date));
    const added = b.filter(r => r.date && !seen.has(r.date));
    const all = [...a, ...added];
    // los registros viejos sin fecha se conservan al principio; el resto ordenado por fecha
    const undated = all.filter(r => !r.date);
    const dated = all.filter(r => r.date).sort((x, y) => x.date.localeCompare(y.date));
    return { list: [...undated, ...dated], added: added.length };
  };
  const o = merge(existing.overnight || [], incoming.overnight || []);
  const i = merge(existing.ib || [], incoming.ib || []);
  return { history: { overnight: o.list, ib: i.list }, added: o.added };
}

async function main() {
  const args = process.argv.slice(2);
  const useKv = args.includes('--kv');
  const dry = args.includes('--dry');

  console.log(`Descargando ${SYMBOL} (velas de 1 min, últimos ~${MAX_BACK_DAYS} días)...`);
  const bars = await fetchLast30Days();
  if (bars.length === 0) throw new Error('Yahoo no devolvió velas. Probá de nuevo en unos minutos.');
  console.log(`  ${bars.length} velas descargadas.`);

  const todayKey = box.nyParts(Date.now()).dateKey;
  const incoming = buildHistoryFromBars(bars, todayKey);
  console.log(`  ${incoming.overnight.length} días completos calculados (hasta ayer).`);

  let existing = { overnight: [], ib: [] };
  try { existing = JSON.parse(fs.readFileSync(HIST_PATH, 'utf-8')); } catch (e) { /* archivo nuevo */ }

  let kv = null;
  if (useKv) {
    if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
      throw new Error('Faltan KV_REST_API_URL / KV_REST_API_TOKEN. Corré primero: npx vercel env pull .env.local');
    }
    kv = require('@vercel/kv').kv;
    const remote = await kv.get('box_history');
    if (remote) {
      const r = typeof remote === 'string' ? JSON.parse(remote) : remote;
      // el historial de la base de datos (capturas diarias reales) manda sobre el archivo local
      existing = mergeHistories(r, existing).history;
    }
  }

  const { history, added } = mergeHistories(existing, incoming);
  const total = history.overnight.length;
  console.log(`Días nuevos agregados: ${added}. Total acumulado: ${total}.`);
  const s = box.summarize(history.overnight);
  console.log(`  Ruptura alcista: n=${s.alcista.n || 0}` + (s.alcista.n ? ` | continúa ${s.alcista.pctContinuacion}%` : ''));
  console.log(`  Ruptura bajista: n=${s.bajista.n || 0}` + (s.bajista.n ? ` | continúa ${s.bajista.pctContinuacion}%` : ''));
  if (total < 30) console.log(`  Aviso: el sistema exige 30 días para usar la caja dinámica (faltan ${30 - total}); el capturador diario los completa solo.`);

  if (dry) { console.log('(--dry: no se escribió nada)'); return; }
  fs.writeFileSync(HIST_PATH, JSON.stringify(history, null, 2));
  console.log(`Guardado en ${path.relative(process.cwd(), HIST_PATH)}`);
  if (kv) { await kv.set('box_history', JSON.stringify(history)); console.log('Guardado también en la base de datos de Vercel (KV).'); }
}

if (require.main === module) main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
module.exports = { buildHistoryFromBars, mergeHistories, fetchLast30Days };
