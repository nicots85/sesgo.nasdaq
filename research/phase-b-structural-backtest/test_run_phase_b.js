const assert = require('assert');
const { runPhaseB } = require('./run-phase-b');

/**
 * Genera un dataset sintético de N días donde el NIKKEI (el único factor
 * estructural con peso real tras la re-ponderación de Fase 2, 0.06)
 * alterna entre subidas y bajadas fuertes en bloques, y el retorno de
 * Nasdaq del MISMO día sigue al Nikkei (señal de pre-market asiático,
 * legítima con la regla de lag 'change-D'). El resto de los factores se
 * mantiene neutro (sin señal) para no contaminar la prueba.
 *
 * Nasdaq y Nikkei se construyen con una relación lineal (cointegración)
 * para que Nikkei tenga su peso completo (0.06) en el sub-score
 * estructural.
 */
function buildSyntheticDataset(nDays = 200) {
  const dates = [];
  const byDate = {};
  let nikkeiPrice = 30000;
  let nasdaqPrice = 20000;

  for (let i = 0; i < nDays; i++) {
    const date = `2024-01-${String((i % 28) + 1).padStart(2, '0')}-${Math.floor(i / 28)}`; // fechas únicas, no necesitan ser reales
    dates.push(date);

    // Nikkei sube/baja en bloques de 5 días (+1.5% / -1.5% diario, señal fuerte)
    const drift = Math.floor(i / 5) % 2 === 0 ? 0.015 : -0.015;
    const noise = (Math.random() - 0.5) * 0.001;
    nikkeiPrice = nikkeiPrice * (1 + drift + noise);
    // Nasdaq sigue al Nikkei el mismo día (relación lineal → cointegración)
    nasdaqPrice = nikkeiPrice * 0.6667 + (Math.random() - 0.5) * 5;

    byDate[date] = {
      nikkei: nikkeiPrice,
      nasdaq: nasdaqPrice,
      vix: 15 + Math.random() * 5,       // sin señal (ruido puro)
      kospi: 2500 + Math.random() * 10,   // sin señal
      sp500: 5000 + Math.random() * 10,   // sin señal
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
  // Ojo: la señal viene del NIKKEI (peso 0.06, único estructural con
  // peso real tras la Fase 2), no del VIX (que bajó a 0.01 por no
  // pasar Bonferroni). El VIX ya no puede mover el sub-score estructural.
  assert(resultado.correlacionScoreVsRetorno.r > 0.3,
    `esperaba correlación positiva fuerte (Nikkei sube → Nasdaq sube), dio r=${resultado.correlacionScoreVsRetorno.r}`);
  assert(resultado.correlacionScoreVsRetorno.significativo,
    `esperaba que la correlación fuera estadísticamente significativa con esta señal tan fuerte, dio p=${resultado.correlacionScoreVsRetorno.pValue}`);
  assert(resultado.tasaAciertoDireccional.pct > 70,
    `esperaba una tasa de acierto alta (>70%) con una señal tan fuerte, dio ${resultado.tasaAciertoDireccional.pct}%`);

  console.log('\nOK: el pipeline de Fase B detecta correctamente una señal fuerte diseñada de antemano (Nikkei sube → Nasdaq sube).');
  console.log('Esto confirma que la lógica de lag anti-look-ahead, extractStructuralScore() y la integración con calculateBias funcionan.');
}

run().catch(e => {
  console.error('FALLÓ:', e);
  process.exit(1);
});
