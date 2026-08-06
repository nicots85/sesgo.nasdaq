const { calculateBias, computeFase2Weights } = require('../api/bias');
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

// correlations con NINGUNO cointegrado → Nikkei y KOSPI caen a piso 0.01
function nonCointegratedCorrelations() {
  return {
    nikkei__nasdaq: { cointegration: { isCointegrated: false } },
    kospi__nasdaq: { cointegration: { isCointegrated: false } }
  };
}

function weightOf(bias, name) {
  const f = bias.factors.find(x => x.name === name);
  assert(f, `factor "${name}" no encontrado`);
  return f.weight;
}

function run() {
  const news = { overall_score: 25 };

  // ------------------------------------------------------------------
  // Test directo de computeFase2Weights: "fallback + Nikkei NO
  // cointegrado". El peso liberado debe ser DINÁMICO (0.40, incluyendo
  // los 0.05 que Nikkei libera al caer a piso), NO la constante fija 0.35.
  // ------------------------------------------------------------------
  const weights = computeFase2Weights(false, false);
  assert(Math.abs(weights.pesoLiberado - 0.40) < 1e-9,
    `peso liberado debería ser 0.40 (0.35 de los 6 + 0.05 de Nikkei), es ${weights.pesoLiberado}`);
  assert(Math.abs(weights.caja - 0.90) < 1e-9,
    `Caja debería recibir todo el liberado dinámico: 0.50 + 0.40 = 0.90, es ${weights.caja}`);
  assert(Math.abs(weights.nikkei - 0.01) < 1e-9,
    `Nikkei sin cointegración debería quedar en piso 0.01, es ${weights.nikkei}`);

  // Contraste: con Nikkei COintegrado, el liberado sigue siendo 0.35.
  const weightsCoint = computeFase2Weights(false, true);
  assert(Math.abs(weightsCoint.pesoLiberado - 0.35) < 1e-9,
    `con Nikkei cointegrado el liberado debería ser 0.35, es ${weightsCoint.pesoLiberado}`);

  console.log('computeFase2Weights(false, false) → pesoLiberado =', weights.pesoLiberado,
    '| Caja =', weights.caja, '| Nikkei =', weights.nikkei);
  console.log('computeFase2Weights(false, true)  → pesoLiberado =', weightsCoint.pesoLiberado,
    '| Caja =', weightsCoint.caja, '| Nikkei =', weightsCoint.nikkei);
  console.log('');

  // ------------------------------------------------------------------
  // Integración: calculateBias con boxSummary null (fallback) y Nikkei
  // NO cointegrado. Caja debe quedar en 0.90 y la suma de pesos en 1.10
  // (todos los pesos base redistribuidos, sin "agujero" de 0.05).
  // ------------------------------------------------------------------
  const bias = calculateBias(sampleMarket(), nonCointegratedCorrelations(), news, null);

  assert(Math.abs(weightOf(bias, 'Caja overnight') - 0.90) < 1e-9,
    `fallback + no coint: Caja debería ser 0.90 (incluye el 0.05 extra de Nikkei), es ${weightOf(bias, 'Caja overnight')}`);
  assert(Math.abs(weightOf(bias, 'Nikkei') - 0.01) < 1e-9,
    `fallback + no coint: Nikkei debería ser 0.01, es ${weightOf(bias, 'Nikkei')}`);

  const suma = bias.factors.reduce((acc, f) => acc + f.weight, 0);
  assert(Math.abs(suma - 1.10) < 1e-9,
    `fallback + no coint: la suma de pesos debería ser 1.10 (sin agujero de 0.05), dio ${suma}`);

  console.log('calculateBias (fallback, Nikkei no cointegrado):');
  console.log('  cajaModo =', bias.cajaModo);
  for (const f of bias.factors) {
    console.log(`    ${f.name.padEnd(18)} weight=${f.weight}`);
  }
  console.log(`  Caja overnight = ${weightOf(bias, 'Caja overnight')} | Nikkei = ${weightOf(bias, 'Nikkei')} | suma pesos = ${suma}`);
  console.log('');
  console.log('OK: el peso liberado es DINÁMICO — cuando Nikkei no está cointegrado libera sus 0.05 extra al pool,');
  console.log('    y Caja overnight recibe ese extra (0.90). No se pierde peso en el cálculo.');
}

run();
