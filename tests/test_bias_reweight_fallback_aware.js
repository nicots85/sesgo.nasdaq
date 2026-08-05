const { calculateBias } = require('../api/bias');
const assert = require('assert');

// Datos de ejemplo: mercado alcista (Nasdaq +2%, S&P +1%, VIX bajo, etc.)
function sampleMarket() {
  return {
    vix: { price: 16.5 },
    dxy: { price: 100.5 },
    usdjpy: { change: 0.4 },
    nikkei: { change: 1.2 },
    kospi: { change: 0.8 },
    sp500: { change: 1.0 },
    nasdaq: { change: 2.0 },
    wti: { price: 72 },
    fearGreed: { value: 39, label: 'Miedo' }
  };
}

// correlations con Nikkei Y KOSPI cointegrados → Nikkei mantiene 0.06 base
function cointegratedCorrelations() {
  return {
    nikkei__nasdaq: { cointegration: { isCointegrated: true } },
    kospi__nasdaq: { cointegration: { isCointegrated: true } }
  };
}

// boxSummary DINÁMICO: Caja overnight ya tiene historial real (>= 15 días
// alcista) → regla original de la Fase 2 (100% del liberado a Caja).
const boxDinamico = {
  nDiasAcumulados: 40,
  overnight: { alcista: { n: 40, pctContinuacion: 58, magnitudMediaContinuacionPct: 1.2 } }
};

function weightOf(bias, name) {
  const f = bias.factors.find(x => x.name === name);
  assert(f, `factor "${name}" no encontrado`);
  return f.weight;
}

function run() {
  const news = { overall_score: 25 };

  // ------------------------------------------------------------------
  // CASO 1: FALLBACK (boxSummary = null) → Caja NO debe ser 0.85.
  // El peso liberado (0.35) se reparte 50/50: Caja 0.50+0.175 = 0.675,
  // Nikkei 0.06+0.175 = 0.235.
  // ------------------------------------------------------------------
  const biasFallback = calculateBias(sampleMarket(), cointegratedCorrelations(), news, null);

  assert(biasFallback.cajaModo === 'fallback',
    `fallback: cajaModo debería ser 'fallback', es '${biasFallback.cajaModo}'`);
  assert(weightOf(biasFallback, 'Caja overnight') === 0.675,
    `fallback: Caja overnight NO debería ser 0.85 (concentración), es ${weightOf(biasFallback, 'Caja overnight')}`);
  assert(weightOf(biasFallback, 'Nikkei') === 0.235,
    `fallback: Nikkei debería recibir parte del liberado (0.235), es ${weightOf(biasFallback, 'Nikkei')}`);

  const sumaFallback = biasFallback.factors.reduce((acc, f) => acc + f.weight, 0);
  assert(Math.abs(sumaFallback - 1.10) < 1e-9,
    `fallback: la suma de pesos debería ser 1.10, dio ${sumaFallback}`);

  console.log('CASO 1 (fallback, boxSummary null):');
  console.log(`  cajaModo = ${biasFallback.cajaModo}`);
  for (const f of biasFallback.factors) {
    console.log(`    ${f.name.padEnd(18)} weight=${f.weight}`);
  }
  console.log(`  Caja overnight = ${weightOf(biasFallback, 'Caja overnight')} (NO 0.85) | Nikkei = ${weightOf(biasFallback, 'Nikkei')}`);
  console.log('');

  // ------------------------------------------------------------------
  // CASO 2: DINÁMICO (boxSummary con >= 15 días alcista) → la regla
  // original de la Fase 2: Caja recibe el 100% del liberado (0.85).
  // ------------------------------------------------------------------
  const biasDinamico = calculateBias(sampleMarket(), cointegratedCorrelations(), news, boxDinamico);

  assert(biasDinamico.cajaModo === 'dinamico',
    `dinámico: cajaModo debería ser 'dinamico', es '${biasDinamico.cajaModo}'`);
  assert(weightOf(biasDinamico, 'Caja overnight') === 0.85,
    `dinámico: Caja overnight debería recibir el 100% del liberado (0.85), es ${weightOf(biasDinamico, 'Caja overnight')}`);
  assert(weightOf(biasDinamico, 'Nikkei') === 0.06,
    `dinámico: Nikkei debería quedar en su peso base (0.06), es ${weightOf(biasDinamico, 'Nikkei')}`);

  const sumaDinamico = biasDinamico.factors.reduce((acc, f) => acc + f.weight, 0);
  assert(Math.abs(sumaDinamico - 1.10) < 1e-9,
    `dinámico: la suma de pesos debería ser 1.10, dio ${sumaDinamico}`);

  console.log('CASO 2 (dinámico, boxSummary con >= 15 días):');
  console.log(`  cajaModo = ${biasDinamico.cajaModo}`);
  console.log(`  Caja overnight = ${weightOf(biasDinamico, 'Caja overnight')} (100% del liberado) | Nikkei = ${weightOf(biasDinamico, 'Nikkei')}`);
  console.log('');
  console.log('OK: el peso liberado (0.35) se reparte 50/50 Caja/Nikkei en fallback,');
  console.log('    y vuelve 100% a Caja cuando box-capture.js tiene historial dinámico real.');
}

run();
