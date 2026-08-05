const assert = require('assert');
const { runPhaseBPerFactor } = require('./run-phase-b-per-factor');

/**
 * TEST POSITIVO: dataset sintético donde SOLO el factor VIX tiene señal
 * real diseñada (VIX bajo ayer → Nasdaq sube fuerte hoy; VIX alto ayer →
 * Nasdaq baja fuerte hoy). El resto de los factores es ruido puro.
 *
 * El pipeline TIENE que detectar a VIX como el único significativo (y que
 * pase la corrección de Bonferroni). Si además detectara señal en un
 * factor de ruido, habría un bug en la lógica.
 */
function buildSyntheticDataset(nDays = 400) {
  const dates = [];
  const byDate = {};
  let nasdaqPrice = 20000;
  let vix = 15;

  for (let i = 0; i < nDays; i++) {
    const date = `2024-01-${String((i % 28) + 1).padStart(2, '0')}-${Math.floor(i / 28)}`;
    dates.push(date);

    // VIX alterna aleatoriamente entre 12 (score 80) y 28 (score -80).
    // Ojo: NO en bloques fijos — los bloques crean correlación serial
    // artificial en los retornos del Nasdaq que el candidato "momentum
    // lag-1" capturaría por casualidad, ensuciando la prueba.
    vix = Math.random() < 0.5 ? 12 : 28;

    // El retorno de Nasdaq de HOY reacciona al VIX de AYER (lag 1)
    const prevVix = i === 0 ? 15 : byDate[dates[i - 1]].vix;
    const drift = prevVix < 20 ? 0.012 : -0.012;
    const noise = (Math.random() - 0.5) * 0.002;
    nasdaqPrice = nasdaqPrice * (1 + drift + noise);

    byDate[date] = {
      nikkei: 30000 + Math.random() * 10, // ruido puro
      kospi: 2500 + Math.random() * 10,   // ruido puro
      nasdaq: nasdaqPrice,
      sp500: 5000 + Math.random() * 10,   // ruido puro
      vix,
      dxy: 100 + Math.random() * 0.1,     // ruido puro
      usdjpy: 150 + Math.random() * 0.1,  // ruido puro
      wti: 75 + Math.random() * 0.1,      // ruido puro
    };
  }

  return { byDate, dates };
}

async function mockFetchAllAligned() {
  return buildSyntheticDataset(400);
}

async function run() {
  const { rows } = await runPhaseBPerFactor(mockFetchAllAligned);
  const structural = rows.filter(r => !r.candidato);

  console.log('\n--- Resultado por factor (test positivo) ---');
  for (const row of rows) {
    console.log(`${row.factor}: r=${row.correlacion.r}, p=${row.correlacion.pValue}, pasaBonferroni=${row.correlacion.pasaBonferroni}, acierto=${row.aciertoDireccional.pct}%`);
  }

  const vix = rows.find(r => r.factor === 'VIX');
  assert(vix, 'debería existir la fila de VIX');
  assert(vix.correlacion.r > 0.3,
    `VIX debería tener correlación positiva fuerte con la señal diseñada, dio r=${vix.correlacion.r}`);
  assert(vix.correlacion.pasaBonferroni,
    `VIX debería pasar la corrección de Bonferroni con una señal tan fuerte, dio p=${vix.correlacion.pValue} (umbral ${vix.correlacion.bonferroni.toFixed(5)})`);
  assert(vix.aciertoDireccional.pct > 70,
    `VIX debería tener alta tasa de acierto direccional (>70%), dio ${vix.aciertoDireccional.pct}%`);

  // Los demás factores son ruido puro: NINGUNO debería pasar Bonferroni
  const falsosPositivos = structural.filter(r => r.factor !== 'VIX' && r.correlacion.pasaBonferroni);
  assert(falsosPositivos.length === 0,
    `factores de ruido puro no deberían pasar Bonferroni, pasaron: ${falsosPositivos.map(f => f.factor).join(', ')}`);

  console.log('\nOK: el pipeline detecta a VIX como único factor significativo (pasa Bonferroni) y NO inventa señal en los 6 factores de ruido puro.');
}

run().catch(e => {
  console.error('FALLÓ:', e);
  process.exit(1);
});
