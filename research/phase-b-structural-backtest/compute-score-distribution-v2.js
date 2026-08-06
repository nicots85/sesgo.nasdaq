/**
 * FASE 3 v2 — Distribución del score con variación SIMULADA de los dos
 * factores que la calibración original mantuvo CONGELADOS.
 *
 * PROBLEMA que corrige: compute-score-distribution.js reconstruyó el score
 * histórico con "Noticias (IA) = 0" y "Caja overnight = valor de referencia
 * fijo (56.7%)" todos los días. Eso es correcto para la Fase B (aislar el
 * edge del resto), pero la MISMA serie se usó para calibrar los umbrales
 * (Fase 3), y el resultado (min=5, max=16 en 388 días) muestra un score que
 * NUNCA fue negativo: porque los dos factores de mayor peso combinado
 * (~0.80-0.98) nunca variaron en esa medición.
 *
 * ESTA VERSIÓN genera variantes de la distribución con muestreo:
 *   - Noticias (IA): NO hay historial real acumulado en producción (el KV
 *     solo guarda score/label del día, no el overall_score de noticias, y
 *     el proyecto en Vercel tiene ~6 días). PROXY documentado: N(0, 50)
 *     truncada a [-100, 100], centrada en 0 (el score de noticias se acota
 *     a [-100,100] en scoreNoticias). Es una APROXIMACIÓN, no datos reales.
 *   - Caja overnight: se corre con valor de referencia fijo (56.7%, modo
 *     fallback) y con pctContinuación dinámico simulado ~ U(40, 70), para
 *     ver cuánto se ensancha la distribución cuando box-capture.js ya está
 *     en modo dinámico.
 *
 * Método: S simulaciones de bootstrap. En cada una, por día, se muestrea
 * un valor de Noticias (y de Caja si aplica) y se calcula el score con la
 * función REAL de producción (calculateBias). Se concatenan todos los
 * scores de todas las simulaciones y sobre ese pool se calculan los
 * percentiles → distribución marginal esperada del score.
 */
const path = require('path');
const fs = require('fs');
const { calculateBias } = require('../../api/bias');
const { fetchAllAligned } = require('./fetch-daily-history');
const { fearGreedFromVix } = require('./run-phase-b');

const S = 300; // simulaciones de bootstrap

function pctChange(curr, prev) {
  if (prev == null || curr == null || prev === 0) return null;
  return ((curr - prev) / prev) * 100;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

// Normal estándar (Box-Muller)
function randNormal() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Muestreo del score de noticias: N(0, 50) truncada a [-100, 100].
// PROXY (no hay historial real en producción todavía).
function sampleNoticias() {
  const v = randNormal() * 50;
  return Math.max(-100, Math.min(100, v));
}

// Muestreo de pctContinuación dinámico de Caja: U(40, 70).
function sampleCajaDinamica() {
  return 40 + Math.random() * 30;
}

function buildRecords(byDate, dates, fixedCorrelations) {
  const records = [];
  for (let i = 1; i < dates.length; i++) {
    if (i < 2) continue;
    const dToday = dates[i];
    const dPrev = dates[i - 1];
    const dPrev2 = dates[i - 2];
    const today = byDate[dToday];
    const prev = byDate[dPrev];
    const prev2 = byDate[dPrev2];

    const nikkeiChg = pctChange(today.nikkei, prev.nikkei);
    const kospiChg = pctChange(today.kospi, prev.kospi);
    const vixPriceLagged = prev.vix;
    const dxyPriceLagged = prev.dxy;
    const wtiPriceLagged = prev.wti;
    const usdjpyChgLagged = pctChange(prev.usdjpy, prev2.usdjpy);
    const sp500ChgLagged = pctChange(prev.sp500, prev2.sp500);

    if ([vixPriceLagged, dxyPriceLagged, wtiPriceLagged, usdjpyChgLagged, sp500ChgLagged, nikkeiChg, kospiChg].some(v => v == null)) {
      continue;
    }

    records.push({
      market: {
        vix: { price: vixPriceLagged },
        dxy: { price: dxyPriceLagged },
        usdjpy: { change: usdjpyChgLagged },
        nikkei: { change: nikkeiChg },
        kospi: { change: kospiChg },
        sp500: { change: sp500ChgLagged },
        wti: { price: wtiPriceLagged },
        fearGreed: { value: fearGreedFromVix(vixPriceLagged) }
      },
      fixedCorrelations,
    });
  }
  return records;
}

function statsFromScores(pool) {
  const sorted = [...pool].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const mean = pool.reduce((a, b) => a + b, 0) / pool.length;
  const std = Math.sqrt(pool.reduce((a, v) => a + (v - mean) ** 2, 0) / pool.length);
  const P = [10, 25, 30, 40, 50, 60, 70, 75, 90];
  const percentiles = {};
  for (const p of P) percentiles[`p${p}`] = percentile(sorted, p);
  return { min, max, media: Math.round(mean * 100) / 100, desvio: Math.round(std * 100) / 100, percentiles };
}

async function computeScoreDistributionV2(fetchFn = fetchAllAligned) {
  console.log('=== FASE 3 v2: Distribución con variación simulada de Noticias y Caja ===\n');

  const { byDate, dates } = await fetchFn('2y');
  if (dates.length < 60) {
    console.error(`Muestra insuficiente: solo ${dates.length} días alineados.`);
    process.exit(1);
  }

  const nikkeiSeries = dates.map(d => byDate[d].nikkei);
  const kospiSeries = dates.map(d => byDate[d].kospi);
  const nasdaqSeries = dates.map(d => byDate[d].nasdaq);
  const { engleGranger } = require('../../lib/stats');
  const nikkeiCoint = engleGranger(nikkeiSeries, nasdaqSeries);
  const kospiCoint = engleGranger(kospiSeries, nasdaqSeries);
  console.log(`  Nikkei↔Nasdaq cointegrado: ${nikkeiCoint.isCointegrated}`);
  console.log(`  KOSPI↔Nasdaq cointegrado: ${kospiCoint.isCointegrated}\n`);

  const fixedCorrelations = {
    nikkei__nasdaq: { cointegration: { isCointegrated: nikkeiCoint.isCointegrated } },
    kospi__nasdaq: { cointegration: { isCointegrated: kospiCoint.isCointegrated } },
  };

  const records = buildRecords(byDate, dates, fixedCorrelations);
  console.log(`Días base: ${records.length}\n`);

  // --- Variante A: BASELINE (validación) — Noticias=0, Caja=referencia fija.
  // Debe reproducir ~min=5, max=16 (los valores de la calibración original).
  const poolA = records.map(r => {
    const bias = calculateBias(r.market, r.fixedCorrelations, { overall_score: 0 }, null);
    return bias.score;
  });
  const statsA = statsFromScores(poolA);

  // --- Variante B: Noticias muestreada (proxy N(0,50)), Caja=referencia fija.
  const poolB = [];
  for (let s = 0; s < S; s++) {
    for (const r of records) {
      const bias = calculateBias(r.market, r.fixedCorrelations, { overall_score: sampleNoticias() }, null);
      poolB.push(bias.score);
    }
  }
  const statsB = statsFromScores(poolB);

  // --- Variante C: Noticias muestreada + Caja DINÁMICA simulada U(40,70).
  const poolC = [];
  for (let s = 0; s < S; s++) {
    for (const r of records) {
      const boxSim = {
        nDiasAcumulados: 40,
        overnight: { alcista: { n: 40, pctContinuacion: sampleCajaDinamica(), magnitudMediaContinuacionPct: 1.5 } }
      };
      const bias = calculateBias(r.market, r.fixedCorrelations, { overall_score: sampleNoticias() }, boxSim);
      poolC.push(bias.score);
    }
  }
  const statsC = statsFromScores(poolC);

  console.log('--- RESULTADOS (comparados con los actuales: min=5, max=16) ---\n');
  const variants = [
    { nombre: 'A. BASELINE (Noticias=0, Caja=fija 56.7%)   ', stats: statsA },
    { nombre: 'B. Noticias ~N(0,50) + Caja=fija 56.7%      ', stats: statsB },
    { nombre: 'C. Noticias ~N(0,50) + Caja ~U(40,70) (din.) ', stats: statsC },
  ];
  for (const v of variants) {
    console.log(`${v.nombre}`);
    console.log(`   min=${v.stats.min} | max=${v.stats.max} | media=${v.stats.media} | desvío=${v.stats.desvio}`);
    const p = v.stats.percentiles;
    console.log(`   p10=${p.p10} p25=${p.p25} p30=${p.p30} p40=${p.p40} p50=${p.p50} p60=${p.p60} p70=${p.p70} p75=${p.p75} p90=${p.p90}`);
    console.log('');
  }

  // --- Guardar ---
  const outPath = path.join(__dirname, 'score-distribution-v2.json');
  const output = {
    fechaCalculo: new Date().toISOString().split('T')[0],
    nDiasBase: records.length,
    nSimulaciones: S,
    proxyNoticias: 'N(0,50) truncada a [-100,100] — PROXY, no hay historial real en producción (KV solo guarda score/label por día)',
    proxyCajaDinamica: 'U(40,70) — rango plausible de pctContinuación cuando box-capture.js pase a modo dinámico',
    variantes: {
      A_baseline: { neutralizaciones: 'Noticias=0, Caja=referencia fija (56.7%) — reproducción de la calibración original', stats: statsA },
      B_noticias_variable: { neutralizaciones: 'Noticias ~ N(0,50), Caja=referencia fija (56.7%)', stats: statsB },
      C_noticias_caja_dinamica: { neutralizaciones: 'Noticias ~ N(0,50), Caja ~ U(40,70) modo dinámico', stats: statsC },
    },
  };
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Resultado guardado en ${outPath}`);

  return { statsA, statsB, statsC };
}

if (require.main === module) {
  computeScoreDistributionV2().catch(e => {
    console.error('Error corriendo Fase 3 v2:', e);
    process.exit(1);
  });
}

module.exports = { computeScoreDistributionV2, sampleNoticias, sampleCajaDinamica, percentile };
