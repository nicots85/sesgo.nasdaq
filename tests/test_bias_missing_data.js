const { calculateBias } = require('../api/bias');
const assert = require('assert');

/**
 * FASE 4 — Redistribución de peso por dato faltante.
 *
 * Verifica que cuando un factor falla (Noticias por error de Groq, KOSPI
 * corrupto, etc.), calculateBias() lo EXCLUYE del numerador y del
 * denominador (no lo fuerza a score 0 con weight completo, que enfriaba
 * el score hacia neutral artificialmente), y lo reporta en
 * factoresExcluidosPorDatoFaltante.
 */

// Mercado "perfecto": todos los datos presentes.
function sampleMarket() {
  return {
    vix: { price: 16.5 }, dxy: { price: 100.5 }, usdjpy: { change: 0.4 },
    nikkei: { change: 1.2 }, kospi: { change: 0.8 }, sp500: { change: 1.0 },
    nasdaq: { price: 25122.18, change: 2.78 }, wti: { price: 72 },
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
  // ========== Caso A: todo disponible → nada excluido, score normal ==========
  const biasA = calculateBias(sampleMarket(), cointegratedCorrelations(), { overall_score: 25 }, null);
  assert.strictEqual(biasA.factoresExcluidosPorDatoFaltante.length, 0,
    `Caso A: no debería haber excluidos, hay ${JSON.stringify(biasA.factoresExcluidosPorDatoFaltante)}`);
  assert.strictEqual(biasA.factors.length, 9, 'Caso A: deberían seguir los 9 factores');

  // ========== Caso B: Noticias falló (error de Groq) ==========
  const newsFail = { overall_score: 0, confidence: 'baja', error: 'rate limit de Groq (429)' };
  const biasB = calculateBias(sampleMarket(), cointegratedCorrelations(), newsFail, null);

  assert(biasB.factoresExcluidosPorDatoFaltante.includes('Noticias (IA)'),
    `Caso B: "Noticias (IA)" debería estar en factoresExcluidosPorDatoFaltante, está ${JSON.stringify(biasB.factoresExcluidosPorDatoFaltante)}`);

  const noticiasB = biasB.factors.find(f => f.name === 'Noticias (IA)');
  assert.strictEqual(noticiasB.disponible, false, 'Caso B: Noticias debería tener disponible=false');

  // (a) No se cuenta en el denominador: verificar la suma de pesos disponibles
  const pesoDisponibleB = biasB.factors.filter(f => f.disponible).reduce((a, f) => a + f.weight, 0);
  assert(Math.abs(pesoDisponibleB - 0.97) < 1e-9,
    `Caso B: suma de pesos disponibles debería ser 0.97 (1.10 - Noticias 0.13), dio ${pesoDisponibleB}`);

  // (b) Score distinto al que daría si se forzara a 0 con weight completo:
  // simular el comportamiento viejo (Noticias score 0, weight 0.13 en el denominador)
  const biasB_oldBehavior = calculateBias(
    sampleMarket(),
    cointegratedCorrelations(),
    { overall_score: 0 }, // sin error → factor "disponible" con score 0 → comportamiento viejo
    null
  );
  assert.notStrictEqual(biasB.score, biasB_oldBehavior.score,
    `Caso B: el score con exclusión (${biasB.score}) debería diferir del que fuerza 0 con peso completo (${biasB_oldBehavior.score})`);

  // Verificar manualmente el cálculo del caso B (excluyendo Noticias):
  // score = Σ(score×weight de los 8 disponibles) / Σ(weight disponibles)
  const esperado = (() => {
    const disponibles = biasB.factors.filter(f => f.disponible);
    const num = disponibles.reduce((a, f) => a + f.score * f.weight, 0);
    const den = disponibles.reduce((a, f) => a + f.weight, 0);
    return Math.round(num / den);
  })();
  assert.strictEqual(biasB.score, esperado,
    `Caso B: el score debería ser ${esperado} (solo pesos disponibles), dio ${biasB.score}`);

  // ========== Caso C: KOSPI corrupto (_invalid:true) ==========
  const marketC = sampleMarket();
  marketC.kospi = { price: 2600, change: 0, _invalid: true };
  const biasC = calculateBias(marketC, cointegratedCorrelations(), { overall_score: 25 }, null);

  assert(biasC.factoresExcluidosPorDatoFaltante.includes('KOSPI'),
    `Caso C: "KOSPI" debería estar en factoresExcluidosPorDatoFaltante, está ${JSON.stringify(biasC.factoresExcluidosPorDatoFaltante)}`);
  const kospiC = biasC.factors.find(f => f.name === 'KOSPI');
  assert.strictEqual(kospiC.disponible, false, 'Caso C: KOSPI debería tener disponible=false');

  // ========== Caso D: un dato crudo null/undefined ==========
  const marketD = sampleMarket();
  marketD.vix = null; // VIX sin dato
  const biasD = calculateBias(marketD, cointegratedCorrelations(), { overall_score: 25 }, null);
  assert(biasD.factoresExcluidosPorDatoFaltante.includes('VIX'),
    `Caso D: "VIX" debería estar excluido por dato null, está ${JSON.stringify(biasD.factoresExcluidosPorDatoFaltante)}`);
  const vixD = biasD.factors.find(f => f.name === 'VIX');
  assert.strictEqual(vixD.disponible, false, 'Caso D: VIX debería tener disponible=false');
  assert.strictEqual(vixD.score, 0, 'Caso D: el score del factor excluido queda en 0 pero sin pesar');

  // ========== Caso E: TODOS los factores fallan → no dividir por cero ==========
  // La Caja overnight SIEMPRE está disponible (boxSummary dinámico o valor
  // de referencia fijo 56.7% → score 13.4), así que el score queda
  // determinado solo por Caja. Lo que se verifica acá: (a) no hay división
  // por cero, (b) se excluyen los 8 factores de mercado.
  const marketE = {
    vix: null, dxy: null, usdjpy: null, nikkei: null, kospi: null, sp500: null, wti: null
  };
  const biasE = calculateBias(marketE, cointegratedCorrelations(), { overall_score: 0, error: 'todo falló' }, null);
  assert.strictEqual(biasE.score, 13, `Caso E: con solo Caja disponible el score debería ser 13 (56.7% → 13.4 redondeado), dio ${biasE.score}`);
  assert.strictEqual(biasE.factoresExcluidosPorDatoFaltante.length, 8,
    `Caso E: deberían excluirse 8 factores (Caja siempre disponible), se excluyeron ${biasE.factoresExcluidosPorDatoFaltante.length}`);
  const disponiblesE = biasE.factors.filter(f => f.disponible).map(f => f.name);
  assert.deepStrictEqual(disponiblesE, ['Caja overnight'],
    `Caso E: el único disponible debería ser Caja overnight, son ${JSON.stringify(disponiblesE)}`);

  console.log('--- Resultados ---');
  console.log(`Caso A (todo disponible): score=${biasA.score} | excluidos: []`);
  console.log(`Caso B (Noticias falló):  score=${biasB.score} (esperado ${esperado}) | excluidos: ${JSON.stringify(biasB.factoresExcluidosPorDatoFaltante)}`);
  console.log(`  → score con exclusión (${biasB.score}) vs score forzado a 0 con peso completo (${biasB_oldBehavior.score})`);
  console.log(`Caso C (KOSPI corrupto):   score=${biasC.score} | excluidos: ${JSON.stringify(biasC.factoresExcluidosPorDatoFaltante)}`);
  console.log(`Caso D (VIX null):         score=${biasD.score} | excluidos: ${JSON.stringify(biasD.factoresExcluidosPorDatoFaltante)}`);
  console.log(`Caso E (todo falló):       score=${biasE.score} | excluidos: ${biasE.factoresExcluidosPorDatoFaltante.length}`);
  console.log('');
  console.log('OK: los factores con dato faltante se excluyen del numerador y denominador (no se fuerzan a neutral), se reportan en factoresExcluidosPorDatoFaltante, y el score con exclusión difiere del viejo comportamiento (score 0 + weight completo).');
}

run();
