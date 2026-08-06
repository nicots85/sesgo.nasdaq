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

// =====================================================================
// UMBRALES DE ETIQUETA — FASE 3: calibrados contra la distribución REAL
// del score (no valores arbitrarios).
//
// Cálculo: research/phase-b-structural-backtest/compute-score-distribution-v2.js
//   Serie de 388 días (2 años Yahoo), pesos ACTUALIZADOS (Fase 2 + Fase 5),
//   mismas reglas de lag que Fase B, con variación SIMULADA de los dos
//   factores que la calibración original mantuvo congelados (FIX Fase 3 v2):
//     - Noticias (IA): ~N(0,50) truncada a [-100,100] (PROXY, no hay
//       historial real en producción todavía)
//     - Caja overnight: ~U(40,70) simulando el modo DINÁMICO (futuro)
//   Variante C (300 simulaciones de bootstrap): min=-32 | max=48 |
//   media=8.32 | desvío=14.87
//   Percentiles: p10=-12, p30=-1, p70=18, p90=28
//
// NOTA IMPORTANTE: la calibración ORIGINAL (min=5, max=16, umbrales <=15)
// quedó obsoleta por DOS motivos: (1) el fix de Fase 5 cambió los pesos
// (Caja 0.675/Nikkei 0.235 en fallback), ensanchando la distribución a
// min=-7/max=24 incluso con Noticias=0; (2) Noticias y Caja estaban
// congeladas, por lo que el score nunca fue negativo. Esta recalibración
// usa la variante MÁS realista (Noticias variable + Caja dinámica).
//
// Regla objetiva de mapeo (NEUTRAL = 40% central real de los datos):
//   BAJISTA FUERTE:       score <= p10  (<= -12)
//   BAJISTA CON CAUTELA:  p10 <  score <= p30  (-11 a -1)
//   NEUTRAL:              p30 <  score <= p70  (0 a 18)
//   ALCISTA CON CAUTELA:  p70 <  score <= p90  (19 a 28)
//   ALCISTA FUERTE:       score > p90  (> 28)
//
// Son valores FIJOS calculados una vez (no percentiles recalculados en
// cada request). El histórico se recalibra manualmente cada tanto.
// ADVERTENCIA: recalibrar cuando Caja pase a modo dinámico de forma
// sostenida, porque aportará variación real que esta calibración
// (basada en la variante simulada C) todavía no vio de forma real.
// =====================================================================
const THRESHOLDS = {
  alcistaFuerte: 28,   // score > 28 → ALCISTA FUERTE
  alcistaCautela: 18,  // score > 18 → ALCISTA CON CAUTELA
  neutral: -1,         // score > -1 → NEUTRAL
  bajistaCautela: -12, // score > -12 → BAJISTA CON CAUTELA
};

function labelFromScore(finalScore) {
  if (finalScore > THRESHOLDS.alcistaFuerte) return { label: 'ALCISTA FUERTE', emoji: '🟢🟢' };
  if (finalScore > THRESHOLDS.alcistaCautela) return { label: 'ALCISTA CON CAUTELA', emoji: '🟢' };
  if (finalScore > THRESHOLDS.neutral) return { label: 'NEUTRAL', emoji: '🟡' };
  if (finalScore > THRESHOLDS.bajistaCautela) return { label: 'BAJISTA CON CAUTELA', emoji: '🔴' };
  return { label: 'BAJISTA FUERTE', emoji: '🔴🔴' };
}

// =====================================================================
// PESOS — re-ponderación por evidencia (Fase 2) con corrección
// fallback-aware (FIX Fase 5).
//
// Pesos BASE (los que existían ANTES de la Fase 2):
//   Caja overnight 0.50 | VIX 0.10 | DXY 0.08 | USD/JPY 0.08 |
//   Nikkei 0.06 (coint) | KOSPI 0.05 | S&P 500 0.06 | WTI 0.04 |
//   Noticias (IA) 0.13
//
// La Fase 2 bajó a piso 0.01 a los 6 que NO pasaron Bonferroni:
//   liberado = (0.10−0.01)+(0.08−0.01)+(0.08−0.01)+(0.05−0.01)
//            +(0.06−0.01)+(0.04−0.01) = 0.35
//
// FIX Fase 5: ese peso liberado SOLO se reasigna completo a Caja
// overnight cuando Caja usa datos DINÁMICOS reales de box-capture.js
// (>=15 días acumulados). Mientras Caja esté en modo FALLBACK (valor de
// referencia fijo, constante), concentrar el 77% del peso en una
// constante hace que el score casi no se mueva día a día — no es lo que
// se busca. En fallback el liberado se reparte 50/50 entre Caja y Nikkei
// (el único otro factor con evidencia real, superó Bonferroni).
// =====================================================================
const PESOS_BASE = {
  caja: 0.50, vix: 0.10, dxy: 0.08, usdjpy: 0.08,
  nikkei: 0.06, kospi: 0.05, sp500: 0.06, wti: 0.04, noticias: 0.13
};
const PISO_BONFERRONI = 0.01;
const SIN_BONFERRONI = ['vix', 'dxy', 'usdjpy', 'kospi', 'sp500', 'wti'];

/**
 * Peso liberado DINÁMICO: cada factor que ESE DÍA quedó en piso 0.01
 * (no pasó Bonferroni, o Nikkei sin cointegración) libera
 * (pesoOriginal - 0.01). Recalculado en CADA request, NO una constante
 * fija: si Nikkei no está cointegrado también libera su 0.05 extra al
 * pool.
 *
 * @param {boolean} nikkeiCoint  true si Nikkei está cointegrado con Nasdaq
 * @returns {number}
 */
function pesoLiberado(nikkeiCoint) {
  // 0.35 base: los 6 que nunca pasaron Bonferroni (VIX, DXY, USD/JPY,
  // KOSPI, S&P 500, WTI).
  let lib = SIN_BONFERRONI.reduce((acc, k) => acc + (PESOS_BASE[k] - PISO_BONFERRONI), 0);
  // Nikkei sin cointegración también queda en piso → libera 0.05 extra.
  if (!nikkeiCoint) lib += PESOS_BASE.nikkei - PISO_BONFERRONI; // 0.06 - 0.01 = 0.05
  return lib;
}

/**
 * Calcula los pesos de Caja overnight y Nikkei según el modo de Caja y
 * la cointegración de Nikkei. Evaluado en CADA request de /api/bias:
 * cuando box-capture.js cruce el mínimo de 30 días, esta función pasa de
 * modo fallback a modo dinámico automáticamente, sin intervención manual.
 *
 * @param {boolean} cajaDinamica  true si Caja usa datos dinámicos reales
 *                                (boxSummary.overnight.alcista.n >= 15)
 * @param {boolean} nikkeiCoint   true si Nikkei está cointegrado con Nasdaq
 * @returns {{caja: number, nikkei: number, pesoLiberado: number}}
 */
function computeFase2Weights(cajaDinamica, nikkeiCoint) {
  const lib = pesoLiberado(nikkeiCoint);
  const nikkeiBase = nikkeiCoint ? PESOS_BASE.nikkei : PISO_BONFERRONI;
  let caja = PESOS_BASE.caja;
  let nikkei = nikkeiBase;

  if (cajaDinamica) {
    // Regla ORIGINAL de la Fase 2: 100% del liberado a Caja (datos reales)
    caja += lib;
  } else if (nikkeiCoint) {
    // Modo fallback: 50% a Caja, 50% a Nikkei → Caja 0.675, Nikkei 0.235
    caja += lib * 0.5;
    nikkei += lib * 0.5;
  } else {
    // Fallback + Nikkei SIN cointegración: Nikkei no tiene señal utilizable
    // (su score es 0), darle peso liberado solo diluiría el score → queda
    // todo en Caja. Incluye el 0.05 extra que Nikkei libera al caer a piso.
    caja += lib;
  }

  return { caja, nikkei, pesoLiberado: lib };
}

function calculateBias(market, correlations, newsAnalysis, boxSummary) {
  // Lectura con null-coalescing (??): si el dato falta, queda null y el
  // factor se marca disponible:false. NO usamos || porque el fallback
  // "silencioso" a 20/101/75 enmascaraba el dato faltante como si fuera
  // un dato real (enfriando el score hacia neutral artificialmente).
  const vixPrice = market.vix?.price ?? null;
  const dxyPrice = market.dxy?.price ?? null;
  const usdjpyChg = market.usdjpy?.change ?? null;
  const nikkeiChg = market.nikkei?.change ?? null;
  const kospiChg = market.kospi?.change ?? null;
  const sp500Chg = market.sp500?.change ?? null;
  const wtiPrice = market.wti?.price ?? null;
  const newsScore = newsAnalysis?.overall_score ?? null;
  const newsError = newsAnalysis?.error || null;

  const nikkeiCoint = correlations.nikkei__nasdaq?.cointegration?.isCointegrated || false;
  const kospiCoint = correlations.kospi__nasdaq?.cointegration?.isCointegrated || false;

  // KOSPI corrupto (Yahoo devuelve ^KS11 fuera de todo rango plausible,
  // ej. > 12000): market.js lo marca con _invalid:true y un valor
  // estimado. Ese valor NO es un dato real.
  const kospiInvalid = market.kospi?._invalid === true;

  // Caja overnight: usamos el backtest dinámico (box-capture.js) si ya
  // hay suficiente historial acumulado (mínimo 30 días). Si todavía no
  // hay suficientes datos (ej. recién arrancamos a acumular), caemos al
  // valor conservador del backtest manual de 515 días como referencia
  // de arranque, marcado explícitamente como "valor de referencia".
  const FALLBACK_PCT_CONTINUACION = 56.7;
  const FALLBACK_LABEL = 'Backtest manual de referencia (515 días, no se actualiza solo)';

  const cajaDinamica = !!(boxSummary && boxSummary.overnight?.alcista?.n >= 15);

  let cajaDescripcion, cajaRaw;
  if (cajaDinamica) {
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

  // FIX Fase 5: pesos condicionales al modo de Caja (dinámico vs fallback).
  // Evaluado en cada request → cuando box-capture.js cruce los 15 días, el
  // sistema pasa solo a la regla original (100% del liberado a Caja).
  const pesos = computeFase2Weights(cajaDinamica, nikkeiCoint);

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
  //   + S&P 0.05 + WTI 0.03 = 0.35.
  // FIX Fase 5 (condicional): el liberado va 100% a Caja overnight SOLO
  //   cuando Caja usa datos dinámicos reales (computeFase2Weights con
  //   cajaDinamica=true → 0.50+0.35 = 0.85). En modo fallback (constante)
  //   se reparte 50/50: Caja 0.50+0.175 = 0.675, Nikkei 0.06+0.175 = 0.235
  //   (Nikkei es el único otro factor con evidencia real).
  // Noticias (IA) mantiene 0.13: sin historial reconstruible, no testable
  // en el backtest retroactivo (ver METHODOLOGY sección 8).
  // =====================================================================
  const factors = [
    {
      name: 'Caja overnight',
      description: cajaDescripcion,
      score: scoreCaja(cajaRaw),
      weight: pesos.caja,
      raw: cajaRaw,
      disponible: true // siempre disponible: boxSummary dinámico o valor de referencia fijo
    },
    {
      name: 'VIX',
      description: vixPrice == null ? 'Dato no disponible' : (vixPrice < 15 ? 'Mercado tranquilo' : vixPrice < 20 ? 'Elevado' : vixPrice < 25 ? 'Alta volatilidad' : 'Crisis'),
      score: vixPrice == null ? 0 : scoreVix(vixPrice),
      weight: 0.01,
      raw: vixPrice,
      disponible: vixPrice != null
    },
    {
      name: 'DXY (Dólar)',
      description: dxyPrice == null ? 'Dato no disponible' : (dxyPrice < 99 ? 'Dólar débil (bueno para Nasdaq)' : dxyPrice < 102 ? 'Dólar neutro' : dxyPrice < 104 ? 'Dólar fuerte (presión)' : 'Dólar muy fuerte (riesgo)'),
      score: dxyPrice == null ? 0 : scoreDxy(dxyPrice),
      weight: 0.01,
      raw: dxyPrice,
      disponible: dxyPrice != null
    },
    {
      name: 'USD/JPY',
      description: usdjpyChg == null ? 'Dato no disponible' : (usdjpyChg > 0.5 ? 'Yen débil (carry trade activo)' : usdjpyChg < -1 ? 'Yen fortaleciéndose (riesgo)' : 'Estable'),
      score: usdjpyChg == null ? 0 : scoreUsdjpy(usdjpyChg),
      weight: 0.01,
      raw: usdjpyChg,
      disponible: usdjpyChg != null
    },
    {
      name: 'Nikkei',
      description: nikkeiChg == null
        ? 'Dato no disponible'
        : nikkeiCoint
          ? `Cointegrado con Nasdaq: ${nikkeiChg > 0 ? 'sube' : 'baja'} → señal directa`
          : 'Sin relación estructural con Nasdaq',
      score: nikkeiChg == null ? 0 : scoreNikkei(nikkeiChg, nikkeiCoint),
      weight: pesos.nikkei, // PASA Bonferroni (p=0.0009) → mantiene peso (más liberado en fallback)
      raw: nikkeiChg,
      cointegrated: nikkeiCoint,
      disponible: nikkeiChg != null
    },
    {
      name: 'KOSPI',
      description: kospiChg == null || kospiInvalid
        ? 'Dato no disponible'
        : kospiCoint
          ? `Cointegrado con Nasdaq: ${kospiChg > 0 ? 'sube' : 'baja'} → señal directa`
          : 'Sin relación estructural con Nasdaq',
      score: kospiChg == null || kospiInvalid ? 0 : scoreKospi(kospiChg, kospiCoint),
      weight: 0.01, // NO pasa Bonferroni (p=0.0136) → piso mínimo 0.01
      raw: kospiChg,
      cointegrated: kospiCoint,
      disponible: kospiChg != null && !kospiInvalid
    },
    {
      name: 'S&P 500',
      description: sp500Chg == null ? 'Dato no disponible' : (sp500Chg > 0.5 ? 'Mercado subiendo' : sp500Chg < -0.5 ? 'Mercado bajando' : 'Plano'),
      score: sp500Chg == null ? 0 : scoreSp500(sp500Chg),
      weight: 0.01, // NO pasa Bonferroni (p=0.9412) → piso mínimo 0.01
      raw: sp500Chg,
      disponible: sp500Chg != null
    },
    {
      name: 'Crudo (WTI)',
      description: wtiPrice == null ? 'Dato no disponible' : (wtiPrice < 65 ? 'Energía barata (positivo)' : wtiPrice > 90 ? 'Energía cara (inflación)' : wtiPrice > 75 ? 'Elevado (presión inflación)' : 'Normal'),
      score: wtiPrice == null ? 0 : scoreWti(wtiPrice),
      weight: 0.01, // NO pasa Bonferroni (p=0.6864) → piso mínimo 0.01
      raw: wtiPrice,
      disponible: wtiPrice != null
    },
    {
      name: 'Noticias (IA)',
      description: newsError != null
        ? 'Dato no disponible (falló Groq)'
        : newsScore > 20 ? 'Sentimiento positivo' : newsScore < -20 ? 'Sentimiento negativo' : 'Neutral',
      score: newsError != null || newsScore == null ? 0 : scoreNoticias(newsScore),
      weight: 0.13,
      raw: newsScore,
      disponible: newsError == null && newsScore != null
    }
  ];

  // FASE 4 — Redistribución de peso por dato faltante: solo los factores
  // con disponible=true se cuentan en el numerador y el denominador. Los
  // que faltan se EXCLUYEN del todo (no se fuerzan a score 0 con peso
  // completo — eso enfriaba el score hacia neutral artificialmente).
  let totalScore = 0;
  let totalWeight = 0;
  const factoresExcluidosPorDatoFaltante = [];
  for (const f of factors) {
    if (!f.disponible) {
      factoresExcluidosPorDatoFaltante.push(f.name);
      continue;
    }
    totalScore += f.score * f.weight;
    totalWeight += f.weight;
  }
  const finalScore = totalWeight > 0 ? Math.round(totalScore / totalWeight) : 0;

  const { label, emoji } = labelFromScore(finalScore);

  return { score: finalScore, label, emoji, factors, factoresExcluidosPorDatoFaltante, cajaModo: cajaDinamica ? 'dinamico' : 'fallback' };
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

  let news;
  try {
    news = await withTimeout(fetchAndAnalyzeNews(), 15000);
  } catch (e) {
    // FASE 4: si las noticias fallan (timeout, Groq caído, etc.), NO
    // tumbamos todo el endpoint: se marca el factor como no disponible
    // y se excluye del score. newsAnalysis.error lo detecta calculateBias.
    news = {
      analysis: { overall_score: 0, confidence: 'baja', individual: [], key_factor: 'Error al obtener noticias', alert: null, error: e.message },
      sources: { english: 0, spanish: 0, total: 0 },
      headlines: []
    };
  }
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
module.exports.THRESHOLDS = THRESHOLDS;
module.exports.labelFromScore = labelFromScore;
module.exports.computeFase2Weights = computeFase2Weights;
module.exports.PESOS_BASE = PESOS_BASE;
module.exports.pesoLiberado = pesoLiberado;
