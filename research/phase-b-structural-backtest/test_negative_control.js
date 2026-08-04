const assert = require('assert');
const { runPhaseB } = require('./run-phase-b');

/**
 * CONTROL NEGATIVO: todos los activos son ruido puro, sin ninguna
 * relación real con el Nasdaq del día siguiente. Si el pipeline
 * reportara significancia estadística acá, sería evidencia de un sesgo
 * en el test (falso positivo sistemático) — algo grave que invalidaría
 * cualquier resultado de la Fase B real.
 */
function buildPureNoiseDataset(nDays = 200) {
  const dates = [];
  const byDate = {};
  let nasdaqPrice = 20000;

  for (let i = 0; i < nDays; i++) {
    const date = `2024-01-${String((i % 28) + 1).padStart(2, '0')}-${Math.floor(i / 28)}`;
    dates.push(date);

    const noise = (Math.random() - 0.5) * 0.02; // ±1% de ruido puro, sin relación con nada
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
  // Corremos 5 veces con semillas distintas (Math.random no tiene seed
  // fijo acá) para reducir la chance de que una corrida puntual caiga
  // "por azar" en el 5% de falsos positivos que el propio test permite.
  let falsosPositivos = 0;
  const nCorridas = 20;

  for (let i = 0; i < nCorridas; i++) {
    const { resultado } = await runPhaseB(mockFetchNoise);
    const huboSenalFalsa = resultado.correlacionScoreVsRetorno.significativo || resultado.tasaAciertoDireccional.significativo;
    if (huboSenalFalsa) falsosPositivos++;
    console.log(`Corrida ${i + 1}: r=${resultado.correlacionScoreVsRetorno.r}, p=${resultado.correlacionScoreVsRetorno.pValue}, significativo=${huboSenalFalsa}`);
  }

  console.log(`\nFalsos positivos: ${falsosPositivos} de ${nCorridas} corridas`);

  // Con ruido puro y un umbral de p<0.05, es normal y esperable tener
  // ALGÚN falso positivo ocasional (~5% de las veces, por definición del
  // test) — lo que NO es aceptable es que sea sistemático (todas o casi
  // todas las corridas dando "significativo" con puro ruido).
  assert(falsosPositivos <= 4, `demasiados falsos positivos con ruido puro (${falsosPositivos}/${nCorridas}, esperado ~1) — esto sugiere un sesgo real en el pipeline de test, no azar`);

  console.log('\nOK: el pipeline NO inventa señal sistemáticamente cuando no hay ninguna relación real (control negativo pasado).');
}

run().catch(e => {
  console.error('FALLÓ:', e);
  process.exit(1);
});
