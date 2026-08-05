/**
 * FASE B — Backtest retroactivo del sub-score estructural
 *
 * Reutiliza calculateBias() de api/bias.js (la función REAL que corre en
 * producción), alimentada con:
 *   - Noticias (IA) → neutralizada (overall_score: 0)
 *   - Caja overnight → sin historial (boxSummary: null → usa el valor
 *     de referencia fijo, constante todos los días — no afecta la
 *     correlación porque es la MISMA constante para todos los días)
 *   - Los 8 factores estructurales → reconstruidos día por día con
 *     datos históricos reales de Yahoo Finance
 *
 * REGLA CONTRA LOOK-AHEAD BIAS (crítica, ver mensaje de chat):
 *   - Nikkei y KOSPI: usan el dato del MISMO día D (cierran antes de
 *     que abra Nueva York → es información legítima de pre-market)
 *   - VIX, DXY, USD/JPY, S&P 500, WTI: usan el dato del día ANTERIOR
 *     (D-1) — porque en producción, si el score se corriera con el
 *     cierre de HOY de estos activos, ya sería tarde: Nueva York cierra
 *     junto con (o después de) estos mercados
 *
 * Cointegración Nikkei/KOSPI: se calcula UNA sola vez sobre toda la
 * muestra (no día por día) — simplificación documentada por robustez
 * estadística. El score en vivo SÍ recalcula esto cada día; este
 * backtest no, para no penalizar los primeros días de la muestra con
 * tests de cointegración poco confiables por falta de datos.
 *
 * Resultado (outcome) medido: retorno de Nasdaq de cierre a cierre del
 * día D (nasdaq[D] vs nasdaq[D-1]) — el "movimiento del día", que es lo
 * que el score dice estar prediciendo.
 */
const path = require('path');
const { calculateBias } = require('../../api/bias');
const { engleGranger, pearsonR, pValueR } = require('../../lib/stats');
const { fetchAllAligned } = require('./fetch-daily-history');

function pctChange(curr, prev) {
  if (prev == null || curr == null || prev === 0) return null;
  return ((curr - prev) / prev) * 100;
}

/**
 * Sub-score estructural AISLADO: re-pondera SOLO los factores de mercado
 * estructurales, excluyendo explícitamente "Caja overnight" y "Noticias
 * (IA)" (y "Momentum Nasdaq", que no debería existir desde la Fase 1.5,
 * por las dudas).
 *
 * POR QUÉ EXISTE: Fase B testea si el score predice el retorno del Nasdaq.
 * Si usáramos bias.score (el score COMPLETO de calculateBias), "Caja
 * overnight" entra con su peso de producción — y como su score es una
 * CONSTANTE (hoy: fallback de 56.7%, score 13.4, peso 0.85), domina el
 * valor y hasta el SIGNO del score compuesto. Sumar una constante no cambia
 * el coeficiente de Pearson (por eso la correlación seguía "funcionando"),
 * pero sí fija el signo y rompe la tasa de acierto direccional. Como la
 * Caja tiene su propio backtest independiente (box-capture.js), Fase B debe
 * medir lo que no está cubierto por esa Caja — y debe hacerlo SIN importar
 * qué peso tenga la Caja en producción. Si en el futuro Caja vuelve a
 * cambiar de peso, Fase B no debe enterarse.
 */
function extractStructuralScore(biasFactors) {
  const EXCLUIDOS = ['Caja overnight', 'Noticias (IA)', 'Momentum Nasdaq'];
  const incluidos = biasFactors.filter(f => !EXCLUIDOS.includes(f.name));
  const totalScore = incluidos.reduce((sum, f) => sum + f.score * f.weight, 0);
  const totalWeight = incluidos.reduce((sum, f) => sum + f.weight, 0);
  return totalWeight > 0 ? totalScore / totalWeight : 0;
}

async function runPhaseB(fetchFn = fetchAllAligned) {
  console.log('=== FASE B: Backtest del sub-score estructural ===\n');

  const { byDate, dates } = await fetchFn('2y');

  if (dates.length < 60) {
    console.error(`Muestra insuficiente: solo ${dates.length} días alineados. Se necesitan al menos 60-100 para un resultado mínimamente confiable.`);
    process.exit(1);
  }

  // --- Cointegración: UNA sola vez, sobre toda la muestra ---
  const nikkeiSeries = dates.map(d => byDate[d].nikkei);
  const kospiSeries = dates.map(d => byDate[d].kospi);
  const nasdaqSeries = dates.map(d => byDate[d].nasdaq);

  console.log('Calculando cointegración Nikkei↔Nasdaq y KOSPI↔Nasdaq sobre toda la muestra...');
  const nikkeiCoint = engleGranger(nikkeiSeries, nasdaqSeries);
  const kospiCoint = engleGranger(kospiSeries, nasdaqSeries);
  console.log(`  Nikkei↔Nasdaq cointegrado: ${nikkeiCoint.isCointegrated} (testStat: ${nikkeiCoint.testStat?.toFixed(3)})`);
  console.log(`  KOSPI↔Nasdaq cointegrado: ${kospiCoint.isCointegrated} (testStat: ${kospiCoint.testStat?.toFixed(3)})\n`);

  const fixedCorrelations = {
    nikkei__nasdaq: { cointegration: { isCointegrated: nikkeiCoint.isCointegrated } },
    kospi__nasdaq: { cointegration: { isCointegrated: kospiCoint.isCointegrated } },
  };

  // --- Reconstrucción día por día (empezamos en el índice 1, necesitamos D-1) ---
  const records = [];
  let excluidosPorDatoFaltante = 0;

  for (let i = 1; i < dates.length; i++) {
    const dToday = dates[i];
    const dPrev = dates[i - 1];
    const today = byDate[dToday];
    const prev = byDate[dPrev];

    // Nikkei/KOSPI: dato del mismo día (legítimo, cierran antes que NY)
    const nikkeiChg = pctChange(today.nikkei, prev.nikkei);
    const kospiChg = pctChange(today.kospi, prev.kospi);

    // VIX/DXY/WTI: NIVEL del día ANTERIOR (no el de hoy)
    // USD/JPY/S&P500: CAMBIO calculado con el cierre de AYER vs anteayer
    if (i < 2) { excluidosPorDatoFaltante++; continue; } // necesitamos D-2 para el "cambio de ayer"
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
      fearGreed: { value: null } // calculado abajo desde el VIX ya-lagged, misma fórmula que fetchFearGreed
    };
    market.fearGreed.value = fearGreedFromVix(vixPriceLagged);

    const bias = calculateBias(market, fixedCorrelations, { overall_score: 0 }, null);

    const nasdaqReturn = pctChange(today.nasdaq, prev.nasdaq);

    records.push({
      date: dToday,
      structuralScore: extractStructuralScore(bias.factors),
      nasdaqReturnPct: nasdaqReturn,
    });
  }

  console.log(`Días utilizables: ${records.length} (excluidos por dato faltante: ${excluidosPorDatoFaltante})\n`);

  // --- Estadística: ¿el score predice el retorno? ---
  const scores = records.map(r => r.structuralScore);
  const returns = records.map(r => r.nasdaqReturnPct);

  const corr = pearsonR(scores, returns);
  const pval = pValueR(corr.r, corr.n);

  // Tasa de acierto direccional: ¿el signo del score coincide con el signo del retorno?
  const withSign = records.filter(r => r.structuralScore !== 0 && r.nasdaqReturnPct !== 0);
  const aciertos = withSign.filter(r => Math.sign(r.structuralScore) === Math.sign(r.nasdaqReturnPct)).length;
  const tasaAcierto = withSign.length > 0 ? (aciertos / withSign.length) * 100 : null;

  // Test binomial simple contra 50% (aproximación normal, suficiente para N grande)
  const nSign = withSign.length;
  const seBinom = Math.sqrt(0.25 / nSign);
  const zScore = nSign > 0 ? ((aciertos / nSign) - 0.5) / seBinom : null;
  const pValBinomAprox = zScore != null ? 2 * (1 - normalCdf(Math.abs(zScore))) : null;

  const resultado = {
    nDiasTotales: records.length,
    nExcluidosPorDatoFaltante: excluidosPorDatoFaltante,
    cointegracion: {
      nikkei: { isCointegrated: nikkeiCoint.isCointegrated, testStat: nikkeiCoint.testStat },
      kospi: { isCointegrated: kospiCoint.isCointegrated, testStat: kospiCoint.testStat },
    },
    correlacionScoreVsRetorno: {
      r: Math.round(corr.r * 1000) / 1000,
      n: corr.n,
      pValue: Math.round(pval * 10000) / 10000,
      significativo: pval < 0.05,
    },
    tasaAciertoDireccional: {
      n: nSign,
      aciertos,
      pct: tasaAcierto != null ? Math.round(tasaAcierto * 10) / 10 : null,
      pValueAprox: pValBinomAprox != null ? Math.round(pValBinomAprox * 10000) / 10000 : null,
      significativo: pValBinomAprox != null ? pValBinomAprox < 0.05 : null,
    },
    conclusion: null,
  };

  if (resultado.nDiasTotales < 60) {
    resultado.conclusion = 'MUESTRA INSUFICIENTE — no concluyente, se necesitan más días.';
  } else if (resultado.correlacionScoreVsRetorno.significativo || resultado.tasaAciertoDireccional.significativo) {
    resultado.conclusion = 'Hay evidencia estadísticamente significativa (p<0.05) de que el sub-score estructural predice algo del retorno diario del Nasdaq.';
  } else {
    resultado.conclusion = 'NO se encontró evidencia estadísticamente significativa (p<0.05) de que el sub-score estructural, tal como está ponderado hoy, prediga el retorno diario del Nasdaq.';
  }

  console.log(JSON.stringify(resultado, null, 2));
  return { resultado, records };
}

function fearGreedFromVix(vixPrice) {
  if (vixPrice == null) return null;
  if (vixPrice <= 12) return 90;
  if (vixPrice <= 15) return 75;
  if (vixPrice <= 19) return 55;
  if (vixPrice <= 24) return 35;
  if (vixPrice <= 30) return 20;
  return 10;
}

// Aproximación de la CDF normal estándar (para el p-value del test binomial)
function normalCdf(x) {
  return 1 - 0.5 * erfc(x / Math.SQRT2);
}
function erfc(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? 1 - y : 1 + y;
}

if (require.main === module) {
  runPhaseB().catch(e => {
    console.error('Error corriendo Fase B:', e);
    process.exit(1);
  });
}

module.exports = { runPhaseB, fearGreedFromVix, extractStructuralScore };
