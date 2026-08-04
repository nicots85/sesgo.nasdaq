const assert = require('assert');
const { runPhaseB } = require('./run-phase-b');

/**
 * Genera un dataset sintético de N días donde el VIX alterna entre
 * "bajo" (12) y "alto" (28) cada pocos días, y el retorno de Nasdaq del
 * día siguiente está diseñado para reaccionar a ese VIX del día
 * anterior: VIX bajo ayer → Nasdaq sube fuerte hoy; VIX alto ayer →
 * Nasdaq baja fuerte hoy. El resto de los factores se mantiene neutro
 * (sin señal) para no contaminar la prueba.
 */
function buildSyntheticDataset(nDays = 200) {
  const dates = [];
  const byDate = {};
  let nasdaqPrice = 20000;
  let vix = 15;

  for (let i = 0; i < nDays; i++) {
    const date = `2024-01-${String((i % 28) + 1).padStart(2, '0')}-${Math.floor(i / 28)}`; // fechas únicas, no necesitan ser reales
    dates.push(date);

    // VIX alterna en bloques de 5 días
    vix = Math.floor(i / 5) % 2 === 0 ? 12 : 28;

    // El retorno de Nasdaq de HOY reacciona al VIX de AYER (lag 1)
    // — esto es lo que el pipeline con lag debería lograr detectar.
    const prevVix = i === 0 ? 15 : byDate[dates[i - 1]].vix;
    const drift = prevVix < 20 ? 0.012 : -0.012; // +1.2% o -1.2% diario, señal fuerte a propósito
    const noise = (Math.random() - 0.5) * 0.002; // ruido chico
    nasdaqPrice = nasdaqPrice * (1 + drift + noise);

    byDate[date] = {
      nikkei: 30000 + Math.random() * 10, // sin señal (ruido puro)
      kospi: 2500 + Math.random() * 10,   // sin señal
      nasdaq: nasdaqPrice,
      sp500: 5000 + Math.random() * 10,   // sin señal
      vix,
      dxy: 100 + Math.random() * 0.1,     // sin señal
      usdjpy: 150 + Math.random() * 0.1,  // sin señal
      wti: 75 + Math.random() * 0.1,      // sin señal
    };
  }

  return { byDate, dates };
}

async function mockFetchAllAligned() {
  return buildSyntheticDataset(200);
}

async function run() {
  const { resultado } = await runPhaseB(mockFetchAllAligned);

  console.log('\n--- Verificaciones ---');

  assert(resultado.nDiasTotales > 150, `esperaba >150 días utilizables, dio ${resultado.nDiasTotales}`);

  // Con una señal tan fuerte y diseñada a propósito, el pipeline TIENE
  // que detectarla como significativa — si esto falla, hay un bug real
  // en la lógica de lag o en la integración con calculateBias.
  assert(resultado.correlacionScoreVsRetorno.r > 0.3,
    `esperaba correlación positiva fuerte (VIX bajo ayer → score alcista → Nasdaq sube hoy), dio r=${resultado.correlacionScoreVsRetorno.r}`);
  assert(resultado.correlacionScoreVsRetorno.significativo,
    `esperaba que la correlación fuera estadísticamente significativa con esta señal tan fuerte, dio p=${resultado.correlacionScoreVsRetorno.pValue}`);
  assert(resultado.tasaAciertoDireccional.pct > 70,
    `esperaba una tasa de acierto alta (>70%) con una señal tan fuerte, dio ${resultado.tasaAciertoDireccional.pct}%`);

  console.log('\nOK: el pipeline de Fase B detecta correctamente una señal fuerte diseñada de antemano (VIX bajo ayer → Nasdaq sube hoy).');
  console.log('Esto confirma que la lógica de lag anti-look-ahead y la integración con calculateBias funcionan.');
}

run().catch(e => {
  console.error('FALLÓ:', e);
  process.exit(1);
});
