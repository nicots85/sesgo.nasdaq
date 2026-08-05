const { calculateBias } = require('../api/bias');
const assert = require('assert');

/**
 * Verifica que los pesos nuevos en calculateBias() coincidan EXACTAMENTE
 * con lo que la tabla de resultados de la Fase 2 (factor por factor,
 * Bonferroni 0.05/7 ≈ 0.0071, 388 días) indica que deberían ser.
 *
 * Solo Nikkei pasó Bonferroni (p=0.0009) → mantiene 0.06 (condicional
 * por cointegración). El resto de los estructurales NO pasó (KOSPI
 * p=0.0136, VIX p=0.0298, DXY p=0.1734, USD/JPY p=0.2533, WTI p=0.6864,
 * S&P p=0.9412) → piso 0.01. El peso liberado (0.35) va completo a
 * Caja overnight: 0.50 + 0.35 = 0.85.
 */
function sampleMarket() {
  return {
    vix: { price: 16.5 }, dxy: { price: 100.5 }, usdjpy: { change: 0.4 },
    nikkei: { change: 1.2 }, kospi: { change: 0.8 }, sp500: { change: 1.0 },
    nasdaq: { price: 25122.18, change: 2.78 }, wti: { price: 72 },
    fearGreed: { value: 55, label: 'Neutral' }
  };
}

function correlations(nikkeiCoint, kospiCoint) {
  return {
    nikkei__nasdaq: { cointegration: { isCointegrated: nikkeiCoint } },
    kospi__nasdaq: { cointegration: { isCointegrated: kospiCoint } }
  };
}

function weightOf(bias, name) {
  const f = bias.factors.find(x => x.name === name);
  assert(f, `debería existir el factor "${name}"`);
  return f.weight;
}

function run() {
  const news = { overall_score: 25 };

  // Caso A: Nikkei y KOSPI cointegrados
  const biasA = calculateBias(sampleMarket(), correlations(true, true), news, null);

  assert(weightOf(biasA, 'Caja overnight') === 0.85, 'Caja overnight debe ser 0.85 (0.50 + 0.35 liberado)');
  assert(weightOf(biasA, 'VIX') === 0.01, 'VIX debe ser 0.01 (no pasa Bonferroni)');
  assert(weightOf(biasA, 'DXY (Dólar)') === 0.01, 'DXY debe ser 0.01 (no pasa Bonferroni)');
  assert(weightOf(biasA, 'USD/JPY') === 0.01, 'USD/JPY debe ser 0.01 (no pasa Bonferroni)');
  assert(weightOf(biasA, 'Nikkei') === 0.06, 'Nikkei debe ser 0.06 (pasa Bonferroni, cointegrado)');
  assert(weightOf(biasA, 'KOSPI') === 0.01, 'KOSPI debe ser 0.01 (no pasa Bonferroni, piso)');
  assert(weightOf(biasA, 'S&P 500') === 0.01, 'S&P 500 debe ser 0.01 (no pasa Bonferroni)');
  assert(weightOf(biasA, 'Crudo (WTI)') === 0.01, 'WTI debe ser 0.01 (no pasa Bonferroni)');
  assert(weightOf(biasA, 'Noticias (IA)') === 0.13, 'Noticias debe seguir en 0.13');

  const sumaA = biasA.factors.reduce((acc, f) => acc + f.weight, 0);
  const TOTAL_COINT = 0.85 + 0.01 + 0.01 + 0.01 + 0.06 + 0.01 + 0.01 + 0.01 + 0.13;
  assert(Math.abs(sumaA - TOTAL_COINT) < 1e-9,
    `suma de pesos cointegrados debería ser ${TOTAL_COINT}, dio ${sumaA}`);
  assert(Math.abs(sumaA - 1.10) < 1e-9, `la suma cointegrada debería ser 1.10, dio ${sumaA}`);

  // Caso B: ninguno cointegrado → solo Nikkei baja a 0.01
  const biasB = calculateBias(sampleMarket(), correlations(false, false), news, null);
  assert(weightOf(biasB, 'Nikkei') === 0.01, 'Nikkei sin cointegración debe ser 0.01');
  assert(weightOf(biasB, 'Caja overnight') === 0.85, 'Caja overnight debe seguir en 0.85');

  const sumaB = biasB.factors.reduce((acc, f) => acc + f.weight, 0);
  assert(Math.abs(sumaB - 1.05) < 1e-9, `la suma sin cointegración debería ser 1.05, dio ${sumaB}`);

  console.log('Caso A (Nikkei+KOSPI cointegrados): suma pesos =', sumaA.toFixed(3), '| score =', biasA.score, `(${biasA.label})`);
  console.log('Caso B (ninguno cointegrado):       suma pesos =', sumaB.toFixed(3), '| score =', biasB.score, `(${biasB.label})`);
  console.log('');
  console.log('PESOS (caso A):');
  for (const f of biasA.factors) console.log(`  ${f.name.padEnd(18)} ${f.weight}`);
  console.log('');
  console.log('OK: los pesos nuevos coinciden exactamente con la tabla de resultados de Fase 2 (solo Nikkei pasa Bonferroni; el peso liberado va completo a Caja overnight = 0.85).');
}

run();
