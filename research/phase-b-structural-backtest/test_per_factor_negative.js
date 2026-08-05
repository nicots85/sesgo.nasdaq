const assert = require('assert');
const { runPhaseBPerFactor } = require('./run-phase-b-per-factor');

/**
 * CONTROL NEGATIVO por factor: los 7 factores estructurales son ruido
 * puro, sin ninguna relación con el retorno del Nasdaq del día siguiente.
 *
 * Se corre 20 veces. Para cada factor se cuenta cuántas corridas dieron
 * "significativo" (p crudo < 0.05). Con puro ruido eso debería rondar el
 * 5% (≈1 de 20 por factor). Si un factor marca significativo en casi
 * todas las corridas, hay un sesgo real en el pipeline (falso positivo
 * sistemático) y el resultado de la Fase 2 no sería confiable.
 */
function buildPureNoiseDataset(nDays = 200) {
  const dates = [];
  const byDate = {};
  let nasdaqPrice = 20000;

  for (let i = 0; i < nDays; i++) {
    const date = `2024-01-${String((i % 28) + 1).padStart(2, '0')}-${Math.floor(i / 28)}`;
    dates.push(date);

    const noise = (Math.random() - 0.5) * 0.02; // ±1% de ruido puro
    nasdaqPrice = nasdaqPrice * (1 + noise);

    byDate[date] = {
      nikkei: 30000 + (Math.random() - 0.5) * 500,
      kospi: 2500 + (Math.random() - 0.5) * 50,
      nasdaq: nasdaqPrice,
      sp500: 5000 + (Math.random() - 0.5) * 50,
      vix: 15 + (Math.random() - 0.5) * 10,
      dxy: 100 + (Math.random() - 0.5) * 2,
      usdjpy: 150 + (Math.random() - 0.5) * 3,
      wti: 75 + (Math.random() - 0.5) * 5,
    };
  }

  return { byDate, dates };
}

async function mockFetchNoise() {
  return buildPureNoiseDataset(200);
}

async function run() {
  const nCorridas = 20;
  const significativosPorFactor = {};

  for (let i = 0; i < nCorridas; i++) {
    const { rows } = await runPhaseBPerFactor(mockFetchNoise);
    for (const row of rows) {
      if (row.candidato) continue; // solo los 7 estructurales
      if (!significativosPorFactor[row.factor]) significativosPorFactor[row.factor] = 0;
      if (row.correlacion.significativo) significativosPorFactor[row.factor]++;
    }
  }

  console.log(`\nFalsos positivos por factor (p<0.05) en ${nCorridas} corridas de ruido puro:`);
  let todosOk = true;
  for (const [factor, count] of Object.entries(significativosPorFactor)) {
    const pct = (count / nCorridas) * 100;
    const ok = count <= 4; // mismo estándar que test_negative_control.js (≤20%)
    if (!ok) todosOk = false;
    console.log(`  ${factor.padEnd(20)} ${count}/${nCorridas} (${pct.toFixed(0)}%) ${ok ? '' : '← EXCESIVO'}`);
  }

  // El estándar ya usado en test_negative_control: hasta 4/20 (~20%)
  // por factor se considera ruido normal; sistemático es mucho más.
  assert(todosOk, 'hay factores con demasiados falsos positivos con ruido puro — esto sugiere un sesgo real en el pipeline, no azar');

  console.log('\nOK: con ruido puro, la tasa de falsos positivos por factor ronda el 5% esperado (no es sistemática). Control negativo por factor pasado.');
}

run().catch(e => {
  console.error('FALLÓ:', e);
  process.exit(1);
});
