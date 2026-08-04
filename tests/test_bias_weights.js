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
    fearGreed: { value: 39, label: 'Miedo' } // sigue llegando a la API, pero NO debe ponderarse
  };
}

// correlations con Nikkei Y KOSPI cointegrados → pesos 0.06 / 0.05
function cointegratedCorrelations() {
  return {
    nikkei__nasdaq: { cointegration: { isCointegrated: true } },
    kospi__nasdaq: { cointegration: { isCointegrated: true } }
  };
}

// correlations con NINGUNO cointegrado → pesos 0.01 / 0.01
function nonCointegratedCorrelations() {
  return {
    nikkei__nasdaq: { cointegration: { isCointegrated: false } },
    kospi__nasdaq: { cointegration: { isCointegrated: false } }
  };
}

function sumWeights(factors) {
  return factors.reduce((acc, f) => acc + f.weight, 0);
}

function run() {
  const news = { overall_score: 25 };

  // Caso A: Nikkei y KOSPI cointegrados
  const biasA = calculateBias(sampleMarket(), cointegratedCorrelations(), news, null);

  const namesA = biasA.factors.map(f => f.name);
  assert(!namesA.includes('Fear & Greed'),
    `Caso A: 'Fear & Greed' NO debería estar en bias.factors, está`);
  assert(!namesA.includes('Momentum Nasdaq'),
    `Caso A: 'Momentum Nasdaq' NO debería estar en bias.factors (circular), está`);

  const cajaA = biasA.factors.find(f => f.name === 'Caja overnight');
  assert(cajaA, 'Caso A: debería existir el factor "Caja overnight"');
  assert(cajaA.weight === 0.50,
    `Caso A: "Caja overnight" debería tener weight 0.50, tiene ${cajaA.weight}`);

  // Total esperado con ambos cointegrados:
  // Caja 0.50 + VIX 0.10 + DXY 0.08 + USD/JPY 0.08 + Nikkei 0.06 +
  // KOSPI 0.05 + S&P500 0.06 + WTI 0.04 + Noticias 0.13 = 1.10
  const TOTAL_COINTEGRADOS = 1.10;
  const sumA = sumWeights(biasA.factors);
  assert(Math.abs(sumA - TOTAL_COINTEGRADOS) < 1e-9,
    `Caso A: la suma de pesos debería ser ${TOTAL_COINTEGRADOS}, dio ${sumA}`);

  // Caso B: ninguno cointegrado
  const biasB = calculateBias(sampleMarket(), nonCointegratedCorrelations(), news, null);

  const namesB = biasB.factors.map(f => f.name);
  assert(!namesB.includes('Fear & Greed'),
    `Caso B: 'Fear & Greed' NO debería estar en bias.factors, está`);

  const cajaB = biasB.factors.find(f => f.name === 'Caja overnight');
  assert(cajaB.weight === 0.50,
    `Caso B: "Caja overnight" debería tener weight 0.50, tiene ${cajaB.weight}`);

  // Total esperado sin cointegración:
  // 1.10 - Nikkei (0.06→0.01) - KOSPI (0.05→0.01) = 1.10 - 0.05 - 0.04 = 1.01
  const TOTAL_SIN_COINTEGRACION = 1.01;
  const sumB = sumWeights(biasB.factors);
  assert(Math.abs(sumB - TOTAL_SIN_COINTEGRACION) < 1e-9,
    `Caso B: la suma de pesos debería ser ${TOTAL_SIN_COINTEGRACION}, dio ${sumB}`);

  console.log(`Caso A (ambos cointegrados): ${biasA.factors.length} factores, suma pesos = ${sumA.toFixed(3)}, score = ${biasA.score} (${biasA.label})`);
  console.log(`Caso B (ninguno cointegrado): ${biasB.factors.length} factores, suma pesos = ${sumB.toFixed(3)}, score = ${biasB.score} (${biasB.label})`);
  console.log('');
  console.log('PESOS POR FACTOR (caso A):');
  for (const f of biasA.factors) {
    console.log(`  ${f.name.padEnd(20)} weight=${f.weight}`);
  }
  console.log('');
  console.log(`OK: 'Fear & Greed' y 'Momentum Nasdaq' eliminados, 'Caja overnight' en 0.50, ` +
    `suma de pesos correcta (${TOTAL_COINTEGRADOS} cointegrados / ${TOTAL_SIN_COINTEGRACION} sin cointegración).`);
}

run();
