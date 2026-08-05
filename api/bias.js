const { fetchMarketData } = require('./market');
const { calculateCorrelations } = require('./correlations');
const { fetchAndAnalyzeNews } = require('./news');
const { getBoxSummary } = require('./box-capture');

require('dotenv').config();

let kv;
try {
  kv = require('@vercel/kv').kv;
} catch (e) {
  kv = null;
}

const fs = require('fs');
const path = require('path');

function withTimeout(promise, ms) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
  return Promise.race([promise, timeout]);
}

// --- Reglas de scoring PURAS (raw → score) ------------------------------
// Exportadas para que el backtest de Fase 2 (test factor por factor) y
// cualquier otra herramienta reutilicen EXACTAMENTE las mismas reglas
// que producción. No debe existir una segunda versión de ninguna regla.
function scoreCaja(pctContinuacion) {
  return (pctContinuacion - 50) * 2; // 50% = neutro (score 0), 100% = score 100
}
function scoreVix(vixPrice) {
  return vixPrice < 15 ? 80 : vixPrice < 17 ? 50 : vixPrice < 20 ? 10 : vixPrice < 25 ? -50 : -80;
}
function scoreDxy(dxyPrice) {
  return dxyPrice < 99 ? 60 : dxyPrice < 102 ? 10 : dxyPrice < 104 ? -30 : -60;
}
function scoreUsdjpy(usdjpyChg) {
  return usdjpyChg > 1 ? 50 : usdjpyChg > 0.3 ? 20 : usdjpyChg < -1.5 ? -80 : usdjpyChg < -0.5 ? -40 : 0;
}
function scoreNikkei(nikkeiChg, cointegrated) {
  if (!cointegrated) return 0;
  return nikkeiChg > 1 ? 60 : nikkeiChg > 0 ? 30 : nikkeiChg < -1 ? -60 : nikkeiChg < 0 ? -30 : 0;
}
function scoreKospi(kospiChg, cointegrated) {
  return scoreNikkei(kospiChg, cointegrated); // misma lógica que Nikkei
}
function scoreSp500(sp500Chg) {
  return sp500Chg > 1 ? 50 : sp500Chg > 0.3 ? 20 : sp500Chg < -1 ? -50 : sp500Chg < -0.3 ? -20 : 0;
}
function scoreWti(wtiPrice) {
  return wtiPrice > 100 ? -50 : wtiPrice > 85 ? -20 : wtiPrice > 70 ? -10 : wtiPrice >= 60 ? 15 : 40;
}
function scoreNoticias(newsScore) {
  return Math.max(-100, Math.min(100, newsScore));
}

function calculateBias(market, correlations, newsAnalysis, boxSummary) {
  const vixPrice = market.vix?.price || 20;
  const dxyPrice = market.dxy?.price || 101;
  const usdjpyChg = market.usdjpy?.change || 0;
  const nikkeiChg = market.nikkei?.change || 0;
  const kospiChg = market.kospi?.change || 0;
  const sp500Chg = market.sp500?.change || 0;
  const wtiPrice = market.wti?.price || 75;
  const newsScore = newsAnalysis?.overall_score || 0;

  const nikkeiCoint = correlations.nikkei__nasdaq?.cointegration?.isCointegrated || false;
  const kospiCoint = correlations.kospi__nasdaq?.cointegration?.isCointegrated || false;

  // Caja overnight: usamos el backtest dinámico (box-capture.js) si ya
  // hay suficiente historial acumulado (mínimo 30 días). Si todavía no
  // hay suficientes datos (ej. recién arrancamos a acumular), caemos al
  // valor conservador del backtest manual de 515 días como referencia
  // de arranque, marcado explícitamente como "valor de referencia".
  const FALLBACK_PCT_CONTINUACION = 56.7;
  const FALLBACK_LABEL = 'Backtest manual de referencia (515 días, no se actualiza solo)';

  let cajaDescripcion, cajaRaw;
  if (boxSummary && boxSummary.overnight?.alcista?.n >= 15) {
    // Usamos la rama alcista como referencia principal del score (misma
    // convención que el resto de los factores: score alto = bullish).
    // Si en algún momento se quiere ponderar alcista y bajista juntos,
    // este es el lugar para hacerlo.
    const alc = boxSummary.overnight.alcista;
    cajaRaw = alc.pctContinuacion;
    cajaDescripcion = `Backtest dinámico ${boxSummary.nDiasAcumulados} días: ruptura alcista continúa ${alc.pctContinuacion}% (${alc.magnitudMediaContinuacionPct ?? '—'}% prom)`;
  } else {
    cajaRaw = FALLBACK_PCT_CONTINUACION;
    cajaDescripcion = FALLBACK_LABEL;
  }

  // =====================================================================
  // PESOS FASE 2 — re-ponderación automática por test factor por factor
  // (run-phase-b-per-factor.js, 388 días, Bonferroni 0.05/7 ≈ 0.0071).
  // Resultado real (r | p crudo | pasa Bonferroni):
  //   Nikkei    0.168 | 0.0009 | SÍ  → mantiene 0.06 (condicional por cointegración)
  //   KOSPI     0.125 | 0.0136 | no  → baja a piso 0.01
  //   VIX      -0.110 | 0.0298 | no  → baja a piso 0.01
  //   DXY       0.069 | 0.1734 | no  → baja a piso 0.01
  //   USD/JPY  -0.058 | 0.2533 | no  → baja a piso 0.01
  //   WTI      -0.021 | 0.6864 | no  → baja a piso 0.01
  //   S&P 500  -0.004 | 0.9412 | no  → baja a piso 0.01
  // Peso liberado total: VIX 0.09 + DXY 0.07 + USD/JPY 0.07 + KOSPI 0.04
  //   + S&P 0.05 + WTI 0.03 = 0.35 → se reasigna COMPLETO a "Caja
  //   overnight" (único factor con evidencia fuerte ya validada en Fase B):
  //   0.50 + 0.35 = 0.85.
  // Noticias (IA) mantiene 0.13: sin historial reconstruible, no testable
  // en el backtest retroactivo (ver METHODOLOGY sección 8).
  // =====================================================================
  const factors = [
    {
      name: 'Caja overnight',
      description: cajaDescripcion,
      score: scoreCaja(cajaRaw),
      weight: 0.85,
      raw: cajaRaw
    },
    {
      name: 'VIX',
      description: vixPrice < 15 ? 'Mercado tranquilo' : vixPrice < 20 ? 'Elevado' : vixPrice < 25 ? 'Alta volatilidad' : 'Crisis',
      score: scoreVix(vixPrice),
      weight: 0.01,
      raw: vixPrice
    },
    {
      name: 'DXY (Dólar)',
      description: dxyPrice < 99 ? 'Dólar débil (bueno para Nasdaq)' : dxyPrice < 102 ? 'Dólar neutro' : dxyPrice < 104 ? 'Dólar fuerte (presión)' : 'Dólar muy fuerte (riesgo)',
      score: scoreDxy(dxyPrice),
      weight: 0.01,
      raw: dxyPrice
    },
    {
      name: 'USD/JPY',
      description: usdjpyChg > 0.5 ? 'Yen débil (carry trade activo)' : usdjpyChg < -1 ? 'Yen fortaleciéndose (riesgo)' : 'Estable',
      score: scoreUsdjpy(usdjpyChg),
      weight: 0.01,
      raw: usdjpyChg
    },
    {
      name: 'Nikkei',
      description: nikkeiCoint
        ? `Cointegrado con Nasdaq: ${nikkeiChg > 0 ? 'sube' : 'baja'} → señal directa`
        : 'Sin relación estructural con Nasdaq',
      score: scoreNikkei(nikkeiChg, nikkeiCoint),
      weight: nikkeiCoint ? 0.06 : 0.01, // PASA Bonferroni (p=0.0009) → mantiene peso
      raw: nikkeiChg,
      cointegrated: nikkeiCoint
    },
    {
      name: 'KOSPI',
      description: kospiCoint
        ? `Cointegrado con Nasdaq: ${kospiChg > 0 ? 'sube' : 'baja'} → señal directa`
        : 'Sin relación estructural con Nasdaq',
      score: scoreKospi(kospiChg, kospiCoint),
      weight: 0.01, // NO pasa Bonferroni (p=0.0136) → piso mínimo 0.01
      raw: kospiChg,
      cointegrated: kospiCoint
    },
    {
      name: 'S&P 500',
      description: sp500Chg > 0.5 ? 'Mercado subiendo' : sp500Chg < -0.5 ? 'Mercado bajando' : 'Plano',
      score: scoreSp500(sp500Chg),
      weight: 0.01, // NO pasa Bonferroni (p=0.9412) → piso mínimo 0.01
      raw: sp500Chg
    },
    {
      name: 'Crudo (WTI)',
      description: wtiPrice < 65 ? 'Energía barata (positivo)' : wtiPrice > 90 ? 'Energía cara (inflación)' : wtiPrice > 75 ? 'Elevado (presión inflación)' : 'Normal',
      score: scoreWti(wtiPrice),
      weight: 0.01, // NO pasa Bonferroni (p=0.6864) → piso mínimo 0.01
      raw: wtiPrice
    },
    {
      name: 'Noticias (IA)',
      description: newsScore > 20 ? 'Sentimiento positivo' : newsScore < -20 ? 'Sentimiento negativo' : 'Neutral',
      score: scoreNoticias(newsScore),
      weight: 0.13,
      raw: newsScore
    }
  ];

  let totalScore = 0;
  let totalWeight = 0;
  for (const f of factors) {
    totalScore += f.score * f.weight;
    totalWeight += f.weight;
  }
  const finalScore = Math.round(totalScore / totalWeight);

  let label, emoji;
  if (finalScore > 60) { label = 'ALCISTA FUERTE'; emoji = '🟢🟢'; }
  else if (finalScore > 20) { label = 'ALCISTA CON CAUTELA'; emoji = '🟢'; }
  else if (finalScore > -20) { label = 'NEUTRAL'; emoji = '🟡'; }
  else if (finalScore > -60) { label = 'BAJISTA CON CAUTELA'; emoji = '🔴'; }
  else { label = 'BAJISTA FUERTE'; emoji = '🔴🔴'; }

  return { score: finalScore, label, emoji, factors };
}

function detectAlerts(bias, prevBias) {
  const alerts = [];
  if (!prevBias) return alerts;

  const scoreDiff = Math.abs(bias.score - prevBias.score);
  if (scoreDiff > 40) {
    alerts.push({
      type: 'volatility',
      message: `Sesgo cambió ${scoreDiff} puntos desde la última sesión`,
      severity: 'alta'
    });
  }

  if (Math.sign(bias.score) !== Math.sign(prevBias.score) && Math.abs(bias.score) > 20) {
    alerts.push({
      type: 'reversal',
      message: `Cambio de dirección: ${prevBias.label} → ${bias.label}`,
      severity: 'alta'
    });
  }

  return alerts;
}

async function loadHistoricalPrices() {
  // 1. Intentar KV (producción Vercel)
  if (kv) {
    try {
      const data = await kv.get('historical:prices');
      if (data) return typeof data === 'string' ? JSON.parse(data) : data;
    } catch (e) { console.warn('KV read failed:', e.message); }
  }
  // 2. Fallback filesystem (desarrollo local)
  try {
    const dataPath = path.join(process.cwd(), 'data', 'historical.json');
    const historical = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    return historical.prices || {};
  } catch (e) { }
  return {};
}

async function saveHistoricalPrices(prices) {
  const data = { lastDate: new Date().toISOString().split('T')[0], prices };
  if (kv) {
    try {
      await kv.set('historical:prices', JSON.stringify(data));
      return;
    } catch (e) { console.warn('KV write failed:', e.message); }
  }
  // Fallback local
  try {
    const dataPath = path.join(process.cwd(), 'data', 'historical.json');
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
  } catch (e) { console.warn('FS write failed:', e.message); }
}

async function ensureHistoricalData() {
  const prices = await loadHistoricalPrices();
  const hasData = Object.values(prices).some(arr => arr && arr.length > 30);
  if (hasData) return prices;

  console.log('Histórico vacío: sembrando datos de Yahoo...');
  const { fetchHistorical, SYMBOLS } = require('./market');
  const seeded = {};
  for (const [name, symbol] of Object.entries(SYMBOLS)) {
    try {
      const data = await fetchHistorical(symbol, 252);
      seeded[name] = (data || []).map(d => d.close);
    } catch (e) {
      seeded[name] = [];
    }
  }
  await saveHistoricalPrices(seeded);
  return seeded;
}

function buildMarketResponse(market) {
  return {
    nikkei: market.nikkei,
    kospi: market.kospi,
    nasdaq: market.nasdaq,
    // Dato informativo de "Nasdaq ahora" (precio + variación del día).
    // Queda FUERA de bias.factors a propósito: usar la variación del
    // propio ^NDX dentro del score que describe el ^NDX sería circular
    // (el mismo activo como insumo y como objetivo). El frontend lo
    // muestra como "estado actual" sin que afecte el número del sesgo.
    nasdaqLive: market.nasdaq ? {
      price: market.nasdaq.price,
      change: market.nasdaq.change,
    } : null,
    sp500: market.sp500,
    vix: market.vix,
    dxy: market.dxy,
    usdjpy: market.usdjpy,
    wti: market.wti,
    fearGreed: market.fearGreed
  };
}

async function getBias() {
  const overallTimeout = 25000;

  const market = await withTimeout(fetchMarketData(), overallTimeout);

  const historicalPrices = await ensureHistoricalData();
  const correlations = calculateCorrelations(historicalPrices);

  const news = await withTimeout(fetchAndAnalyzeNews(), 15000);
  const boxSummary = await getBoxSummary();
  const bias = calculateBias(market, correlations, news.analysis, boxSummary);

  let prevBias = null;
  const today = new Date().toISOString().split('T')[0];
  if (kv) {
    try {
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      prevBias = await kv.get(`bias:${yesterday}`);
    } catch (e) { }
  }

  const alerts = detectAlerts(bias, prevBias);

  let biasHistory = [];
  if (kv) {
    try {
      const monthKey = today.slice(0, 7);
      biasHistory = (await kv.get(`bias_history:${monthKey}`)) || [];
    } catch (e) { }
  }

  return {
    bias,
    market: buildMarketResponse(market),
    correlations,
    boxSummary,
    news,
    biasHistory,
    alerts,
    timestamp: new Date().toISOString()
  };
}

async function handler(req, res) {
  try {
    res.setHeader('Content-Type', 'application/json');
    const result = await getBias();
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

module.exports = handler;
module.exports.getBias = getBias;
module.exports.calculateBias = calculateBias;
module.exports.buildMarketResponse = buildMarketResponse;
module.exports.detectAlerts = detectAlerts;
module.exports.loadHistoricalPrices = loadHistoricalPrices;
module.exports.saveHistoricalPrices = saveHistoricalPrices;
module.exports.scoreCaja = scoreCaja;
module.exports.scoreVix = scoreVix;
module.exports.scoreDxy = scoreDxy;
module.exports.scoreUsdjpy = scoreUsdjpy;
module.exports.scoreNikkei = scoreNikkei;
module.exports.scoreKospi = scoreKospi;
module.exports.scoreSp500 = scoreSp500;
module.exports.scoreWti = scoreWti;
module.exports.scoreNoticias = scoreNoticias;
