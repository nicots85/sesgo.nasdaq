/**
 * FASE 3 — Distribución del score completo con los pesos YA ACTUALIZADOS
 * de la Fase 2, para calibrar los umbrales de etiqueta contra la
 * distribución REAL del score, no contra valores arbitrarios.
 *
 * Reutiliza:
 *   - fetchAllAligned() (2 años) — misma fuente que Fase B
 *   - La MISMA reconstrucción día por día de run-phase-b.js (mismas
 *     reglas de lag anti-look-ahead: Nikkei/KOSPI mismo día; VIX/DXY/WTI
 *     nivel de D-1; USD/JPY/S&P500 cambio de D-1 vs D-2)
 *   - calculateBias() de api/bias.js (la función REAL de producción)
 *
 * Neutralizaciones idénticas a Fase B:
 *   - Noticias (IA) → overall_score: 0 (no hay historial reconstruible)
 *   - Caja overnight → boxSummary: null → usa el valor de referencia
 *     fijo (56.7%) — una CONSTANTE todos los días, no distorsiona la
 *     distribución de la parte variable del score, pero sí desplaza la
 *     distribución entera (sumar una constante).
 *
 * La salida es la serie completa de scores (guardada en un JSON) y los
 * percentiles p10..p90 calculados sobre ella. De ahí salen los umbrales.
 */
const path = require('path');
const fs = require('fs');
const { calculateBias } = require('../../api/bias');
const { fetchAllAligned } = require('./fetch-daily-history');
const { fearGreedFromVix } = require('./run-phase-b');

function pctChange(curr, prev) {
  if (prev == null || curr == null || prev === 0) return null;
  return ((curr - prev) / prev) * 100;
}

/**
 * Percentil tipo "nearest rank": el valor del elemento que está en la
 * posición ceil(p/100 * N) del arreglo ordenado. Mismo criterio que se
 * usa para definir los umbrales (regla objetiva, sin interpolación).
 */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function computeScoreDistribution(fetchFn = fetchAllAligned) {
  console.log('=== FASE 3: Distribución del score completo (pesos Fase 2) ===\n');

  const { byDate, dates } = await fetchFn('2y');

  if (dates.length < 60) {
    console.error(`Muestra insuficiente: solo ${dates.length} días alineados.`);
    process.exit(1);
  }

  // --- Cointegración: UNA sola vez, sobre toda la muestra (igual que Fase B) ---
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

  // --- Reconstrucción día por día (mismas reglas que run-phase-b.js) ---
  const records = [];
  let excluidosPorDatoFaltante = 0;

  for (let i = 1; i < dates.length; i++) {
    const dToday = dates[i];
    const dPrev = dates[i - 1];
    const today = byDate[dToday];
    const prev = byDate[dPrev];

    const nikkeiChg = pctChange(today.nikkei, prev.nikkei);
    const kospiChg = pctChange(today.kospi, prev.kospi);

    if (i < 2) { excluidosPorDatoFaltante++; continue; }
    const dPrev2 = dates[i - 2];
    const prev2 = byDate[dPrev2];

    const vixPriceLagged = prev.vix;
    const dxyPriceLagged = prev.dxy;
    const wtiPriceLagged = prev.wti;
    const usdjpyChgLagged = pctChange(prev.usdjpy, prev2.usdjpy);
    const sp500ChgLagged = pctChange(prev.sp500, prev2.sp500);

    if ([vixPriceLagged, dxyPriceLagged, wtiPriceLagged, usdjpyChgLagged, sp500ChgLagged, nikkeiChg, kospiChg].some(v => v == null)) {
      excluidosPorDatoFaltante++;
      continue;
    }

    const market = {
      vix: { price: vixPriceLagged },
      dxy: { price: dxyPriceLagged },
      usdjpy: { change: usdjpyChgLagged },
      nikkei: { change: nikkeiChg },
      kospi: { change: kospiChg },
      sp500: { change: sp500ChgLagged },
      wti: { price: wtiPriceLagged },
      fearGreed: { value: fearGreedFromVix(vixPriceLagged) }
    };

    // Noticias neutralizadas (0) y Caja en valor de referencia fijo (null) — igual que Fase B
    const bias = calculateBias(market, fixedCorrelations, { overall_score: 0 }, null);

    records.push({ date: dToday, score: bias.score, label: bias.label });
  }

  console.log(`Días con score calculado: ${records.length} (excluidos: ${excluidosPorDatoFaltante})`);

  // --- Serie completa ---
  const scores = records.map(r => r.score);
  const sorted = [...scores].sort((a, b) => a - b);

  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const sum = scores.reduce((a, b) => a + b, 0);
  const mean = sum / scores.length;
  const std = Math.sqrt(scores.reduce((a, v) => a + (v - mean) ** 2, 0) / scores.length);

  // --- Percentiles ---
  const P = [10, 25, 30, 40, 50, 60, 70, 75, 90];
  const percentiles = {};
  for (const p of P) percentiles[`p${p}`] = percentile(sorted, p);

  console.log('\n--- Serie completa de scores ---');
  console.log(`min: ${min} | max: ${max} | media: ${mean.toFixed(2)} | desvío: ${std.toFixed(2)}`);

  console.log('\n--- Percentiles ---');
  for (const p of P) console.log(`  p${p}: ${percentiles[`p${p}`]}`);

  // --- Guardar serie completa ---
  const outPath = path.join(__dirname, 'score-distribution.json');
  const output = {
    fechaCalculo: new Date().toISOString().split('T')[0],
    nDias: records.length,
    pesosFase2: {
      cajaOvernight: 0.85, vix: 0.01, dxy: 0.01, usdjpy: 0.01,
      nikkei: '0.06 o 0.01 (cointegrado o no)', kospi: 0.01, sp500: 0.01, wti: 0.01, noticias: 0.13,
    },
    neutralizaciones: 'Noticias = 0, Caja = valor referencia fijo (56.7%) — igual que Fase B',
    stats: { min, max, media: Math.round(mean * 100) / 100, desvio: Math.round(std * 100) / 100 },
    percentiles,
    serie: records,
  };
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nSerie completa guardada en ${outPath}`);

  return { records, scores, sorted, percentiles, stats: { min, max, media: mean, desvio: std } };
}

if (require.main === module) {
  computeScoreDistribution().catch(e => {
    console.error('Error corriendo Fase 3:', e);
    process.exit(1);
  });
}

module.exports = { computeScoreDistribution, percentile };
