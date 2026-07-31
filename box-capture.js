/**
 * api/box-capture.js
 *
 * Se ejecuta 1 vez por día, DESPUÉS del cierre de la sesión regular de
 * Nueva York (16:00 NY), vía un cron separado del de la mañana (ver
 * vercel.json). Descarga las velas de 1 minuto de HOY para el futuro
 * NQ=F (incluyendo pre-market), calcula el resultado de la caja
 * overnight y de la Initial Balance de hoy, y los agrega al historial
 * acumulado en KV.
 *
 * Por qué NQ=F y no ^NDX: ^NDX (el índice) no cotiza en pre-market —
 * solo se actualiza durante la sesión regular. NQ=F (futuro E-mini
 * Nasdaq-100) sí opera casi 24hs, igual que USTEC, así que es el proxy
 * correcto para la caja overnight.
 *
 * Por qué un cron aparte del de la mañana (api/cron.js): ese cron corre
 * a las 11:00 UTC (antes de la apertura), útil para calcular el sesgo
 * del día. Pero para saber CÓMO TERMINÓ la sesión de hoy (y así poder
 * clasificar continuación/reversión) hace falta esperar al cierre.
 */
require('dotenv').config();

let kv;
try {
  kv = require('@vercel/kv').kv;
} catch (e) {
  kv = null;
}

const fs = require('fs');
const path = require('path');
const box = require('../lib/box');

const BOX_SYMBOL = 'NQ=F';
const MAX_HISTORY_DAYS = 750; // ~3 años de historial acumulado

async function fetchTodayIntraday(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m&includePrePost=true`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result || !result.timestamp) return null;

    const ts = result.timestamp;
    const q = result.indicators.quote[0];
    const bars = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.high[i] == null || q.low[i] == null || q.close[i] == null) continue;
      bars.push({ t: ts[i] * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] });
    }
    return bars;
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}

async function loadBoxHistory() {
  if (kv) {
    try {
      const data = await kv.get('box_history');
      if (data) return typeof data === 'string' ? JSON.parse(data) : data;
    } catch (e) { console.warn('KV read box_history failed:', e.message); }
  }
  try {
    const p = path.join(process.cwd(), 'data', 'box_history.json');
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) { }
  return { overnight: [], ib: [] };
}

async function saveBoxHistory(history) {
  if (kv) {
    try {
      await kv.set('box_history', JSON.stringify(history));
      return;
    } catch (e) { console.warn('KV write box_history failed:', e.message); }
  }
  try {
    const p = path.join(process.cwd(), 'data', 'box_history.json');
    fs.writeFileSync(p, JSON.stringify(history, null, 2));
  } catch (e) { console.warn('FS write box_history failed:', e.message); }
}

/**
 * Devuelve el resumen ya calculado, listo para usar en bias.js.
 * Si hay muy pocos días acumulados todavía, devuelve null (bias.js debe
 * hacer fallback al valor conservador por defecto en ese caso).
 */
async function getBoxSummary(minDiasConfianza = 30) {
  const history = await loadBoxHistory();
  if (!history.overnight || history.overnight.length < minDiasConfianza) {
    return null;
  }
  return {
    overnight: box.summarize(history.overnight),
    ib: box.summarize(history.ib),
    sweepConfirmation: box.sweepConfirmation(history.overnight, history.ib),
    nDiasAcumulados: history.overnight.length,
  };
}

async function captureToday() {
  const bars = await fetchTodayIntraday(BOX_SYMBOL);
  if (!bars || bars.length === 0) {
    return { error: `No se pudo descargar ${BOX_SYMBOL} hoy` };
  }

  const today = box.analyzeSingleDay(bars);
  if (!today) {
    return { error: 'No se pudo agrupar las velas de hoy por fecha NY' };
  }

  const history = await loadBoxHistory();

  const yaExiste = history.overnight.some(r => r.date === today.date);
  if (yaExiste) {
    return { skipped: `ya había un registro para ${today.date}` };
  }

  history.overnight = [...history.overnight, today.overnight].slice(-MAX_HISTORY_DAYS);
  history.ib = [...history.ib, today.ib].slice(-MAX_HISTORY_DAYS);

  await saveBoxHistory(history);

  return {
    success: true,
    date: today.date,
    overnight: today.overnight,
    ib: today.ib,
    totalDiasAcumulados: history.overnight.length,
  };
}

async function handler(req, res) {
  try {
    const result = await captureToday();
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

module.exports = handler;
module.exports.captureToday = captureToday;
module.exports.getBoxSummary = getBoxSummary;
module.exports.loadBoxHistory = loadBoxHistory;
module.exports.saveBoxHistory = saveBoxHistory;
