const { calculateBias, buildMarketResponse } = require('../api/bias');
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
    nasdaq: { price: 25122.18, change: 2.78 }, // dato en vivo, NO debe ponderar
    wti: { price: 72 },
    fearGreed: { value: 55, label: 'Neutral' }
  };
}

function cointegratedCorrelations() {
  return {
    nikkei__nasdaq: { cointegration: { isCointegrated: true } },
    kospi__nasdaq: { cointegration: { isCointegrated: true } }
  };
}

function run() {
  const market = sampleMarket();
  const news = { overall_score: 25 };

  // boxSummary DINÁMICO (>= 15 días): Caja overnight con datos reales →
  // regla original de Fase 2 (Caja recibe 100% del peso liberado = 0.85).
  const boxDinamico = {
    nDiasAcumulados: 40,
    overnight: { alcista: { n: 40, pctContinuacion: 58, magnitudMediaContinuacionPct: 1.2 } }
  };

  const bias = calculateBias(market, cointegratedCorrelations(), news, boxDinamico);

  const names = bias.factors.map(f => f.name);
  assert(!names.includes('Momentum Nasdaq'),
    `'Momentum Nasdaq' NO debería estar en bias.factors (es circular), está`);

  const caja = bias.factors.find(f => f.name === 'Caja overnight');
  assert(caja, 'debería existir el factor "Caja overnight"');
  assert(caja.weight === 0.85,
    `"Caja overnight" debería tener weight 0.85, tiene ${caja.weight}`);

  // El dato de Nasdaq en vivo debe seguir disponible, pero FUERA de factors
  const respMarket = buildMarketResponse(market);
  assert(respMarket.nasdaqLive, 'market.nasdaqLive debería existir en la respuesta');
  assert(respMarket.nasdaqLive.price === 25122.18,
    `market.nasdaqLive.price debería ser 25122.18, dio ${respMarket.nasdaqLive.price}`);
  assert(respMarket.nasdaqLive.change === 2.78,
    `market.nasdaqLive.change debería ser 2.78, dio ${respMarket.nasdaqLive.change}`);
  assert(respMarket.nasdaqLive !== null, 'market.nasdaqLive no debería ser null');

  // Y que ningún factor use ese dato: nadie en factors tiene raw === 2.78
  const usaNasdaq = bias.factors.some(f => f.raw === 2.78);
  assert(!usaNasdaq, 'ningún factor ponderado debería usar el cambio del Nasdaq (2.78) como raw');

  // Suma de pesos esperada: con Nikkei/KOSPI cointegrados
  // Total esperado con ambos cointegrados (tras re-ponderación Fase 2):
  // Caja 0.85 + VIX 0.01 + DXY 0.01 + USD/JPY 0.01 + Nikkei 0.06 +
  // KOSPI 0.01 + S&P500 0.01 + WTI 0.01 + Noticias 0.13 = 1.10
  const TOTAL_COINTEGRADOS = 1.10;
  const suma = bias.factors.reduce((acc, f) => acc + f.weight, 0);
  assert(Math.abs(suma - TOTAL_COINTEGRADOS) < 1e-9,
    `la suma de pesos debería ser ${TOTAL_COINTEGRADOS}, dio ${suma}`);

  console.log(`${bias.factors.length} factores, suma pesos = ${suma.toFixed(3)}, score = ${bias.score} (${bias.label})`);
  console.log('');
  console.log('PESOS POR FACTOR:');
  for (const f of bias.factors) {
    console.log(`  ${f.name.padEnd(20)} weight=${f.weight}`);
  }
  console.log('');
  console.log(`market.nasdaqLive: { price: ${respMarket.nasdaqLive.price}, change: ${respMarket.nasdaqLive.change} }`);
  console.log('');
  console.log(`OK: 'Momentum Nasdaq' eliminado del cálculo (circular), 'Caja overnight' en 0.85 (modo dinámico), ` +
    `y el Nasdaq en vivo sigue en market.nasdaqLive fuera de factors.`);
}

run();
