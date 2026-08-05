const { computeBiasV2, FILTROS_ACTIVOS, PENALIDAD_POR_FACTOR_EN_CONTRA } = require('../api/bias-v2-experimental');
const assert = require('assert');

/**
 * FASE 4, PARTE B — Test de la arquitectura "señal primaria + filtros".
 *
 * Casos sintéticos:
 *   (a) Caja overnight alcista + todos los filtros a favor → confianza 100,
 *       score = Caja overnight sin cambios (señal primaria no atenuada).
 *   (b) Caja overnight alcista + 2 filtros en contra → confianza reducida,
 *       se muestra el cálculo exacto (100 - 2×penalidad).
 *   (c) Un factor que NO pasó Bonferroni (no está en filtros) NO puede
 *       vetar la señal primaria aunque la contradiga.
 */

// Factor Caja overnight: SEÑAL PRIMARIA
const cajaAlcista = { name: 'Caja overnight', score: 40, weight: 0.85, disponible: true };

// Filtros con signos distintos
const filtroNikkeiFavor  = { name: 'Nikkei', score: 30, weight: 0.06, disponible: true };
const filtroNikkeiContra = { name: 'Nikkei', score: -60, weight: 0.06, disponible: true };
const filtroKospiContra  = { name: 'KOSPI', score: -30, weight: 0.01, disponible: true };

// Factor que NO pasó Bonferroni: no debe poder vetar
const vixEnContra = { name: 'VIX', score: -80, weight: 0.01, disponible: true };

function run() {
  // ========== Caso (a): todo a favor → confianza 100, score sin cambios ==========
  const biasA = { factors: [cajaAlcista, filtroNikkeiFavor] };
  const v2A = computeBiasV2(biasA);

  assert.strictEqual(v2A.direccionBase, 1, `Caso A: direccionBase debe ser 1 (alcista), dio ${v2A.direccionBase}`);
  assert.strictEqual(v2A.confianza, 100, `Caso A: confianza debe ser 100 con todos los filtros a favor, dio ${v2A.confianza}`);
  assert.strictEqual(v2A.scoreFinal, 40, `Caso A: scoreFinal debe ser igual al score de Caja (40) sin atenuación, dio ${v2A.scoreFinal}`);
  assert.deepStrictEqual(v2A.desglose.confirmaron, ['Nikkei'], `Caso A: Nikkei debería confirmar, dio ${JSON.stringify(v2A.desglose.confirmaron)}`);
  assert.strictEqual(v2A.desglose.nContradijeron, 0, 'Caso A: no debería haber contradicciones');

  console.log('Caso A (Caja alcista + filtro a favor):');
  console.log(`  confianza = ${v2A.confianza} | scoreFinal = ${v2A.scoreFinal} | confirmaron=${JSON.stringify(v2A.desglose.confirmaron)}`);
  console.log(`  → scoreFinal = direccionBase(+1) × |scoreCaja=40| × (100/100) = 40 ✓\n`);

  // ========== Caso (b): 2 filtros en contra → confianza reducida ==========
  // Usamos filtros custom ['Nikkei','KOSPI'] para ejercitar la mecánica con 2
  // contradicciones. En producción FILTROS_ACTIVOS solo incluye Nikkei (único
  // que pasó Bonferroni), pero la mecánica es parametrizable y se documenta.
  const biasB = { factors: [cajaAlcista, filtroNikkeiContra, filtroKospiContra] };
  const v2B = computeBiasV2(biasB, { filtros: ['Nikkei', 'KOSPI'] });

  assert.strictEqual(v2B.confianza, 100 - 2 * PENALIDAD_POR_FACTOR_EN_CONTRA,
    `Caso B: confianza debe ser 100 - 2×${PENALIDAD_POR_FACTOR_EN_CONTRA} = ${100 - 2 * PENALIDAD_POR_FACTOR_EN_CONTRA}, dio ${v2B.confianza}`);
  assert.strictEqual(v2B.desglose.nContradijeron, 2, 'Caso B: debería haber 2 contradicciones');
  assert.deepStrictEqual(v2B.desglose.contradijeron, ['Nikkei', 'KOSPI'], 'Caso B: los contradictores deben ser Nikkei y KOSPI');

  // Cálculo exacto:
  //   confianza = 100 - 15 (Nikkei) - 15 (KOSPI) = 70
  //   scoreFinal = +1 × 40 × (70/100) = 28
  assert.strictEqual(v2B.scoreFinal, 28, `Caso B: scoreFinal debe ser 40 × 0.70 = 28, dio ${v2B.scoreFinal}`);

  console.log('Caso B (Caja alcista + 2 filtros en contra):');
  console.log(`  confianza = 100 - 2×${PENALIDAD_POR_FACTOR_EN_CONTRA} = ${v2B.confianza}`);
  console.log(`  scoreFinal = +1 × |40| × (${v2B.confianza}/100) = ${v2B.scoreFinal}`);
  console.log(`  contradijeron=${JSON.stringify(v2B.desglose.contradijeron)}\n`);

  // ========== Caso (c): factor sin Bonferroni NO puede vetar ==========
  const biasC = { factors: [cajaAlcista, vixEnContra, filtroNikkeiFavor] };
  const v2C = computeBiasV2(biasC);

  assert.strictEqual(v2C.confianza, 100,
    `Caso C: VIX (no pasó Bonferroni) no puede vetar la señal → confianza debe quedar en 100, dio ${v2C.confianza}`);
  assert.strictEqual(v2C.desglose.nContradijeron, 0, 'Caso C: VIX no debe contar como contradicción');
  assert.deepStrictEqual(v2C.desglose.confirmaron, ['Nikkei'], `Caso C: solo Nikkei confirma, dio ${JSON.stringify(v2C.desglose.confirmaron)}`);

  console.log('Caso C (Caja alcista + VIX en contra + Nikkei a favor):');
  console.log(`  VIX (-80) NO está en FILTROS_ACTIVOS → no veta: confianza = ${v2C.confianza} | confirmaron=${JSON.stringify(v2C.desglose.confirmaron)}\n`);

  // ========== Caso (d): Caja bajista → dirección inversa ==========
  const cajaBajista = { name: 'Caja overnight', score: -30, weight: 0.85, disponible: true };
  const v2D = computeBiasV2({ factors: [cajaBajista, { name: 'Nikkei', score: -20, weight: 0.06, disponible: true }] });
  assert.strictEqual(v2D.direccionBase, -1, `Caso D: direccionBase debe ser -1 (bajista), dio ${v2D.direccionBase}`);
  assert.strictEqual(v2D.scoreFinal, -30, `Caso D: scoreFinal debe ser -30, dio ${v2D.scoreFinal}`);

  console.log('Caso D (Caja bajista + filtro a favor):');
  console.log(`  direccionBase = -1 | scoreFinal = -1 × |-30| × (100/100) = ${v2D.scoreFinal}\n`);

  // ========== Caso (e): filtro con dato faltante no opina ==========
  const nikkeiSinDato = { name: 'Nikkei', score: 0, weight: 0.06, disponible: false };
  const v2E = computeBiasV2({ factors: [cajaAlcista, nikkeiSinDato] });
  assert.strictEqual(v2E.confianza, 100, 'Caso E: filtro no disponible no debe tocar la confianza');
  assert.strictEqual(v2E.desglose.nConfirmaron, 0, 'Caso E: filtro no disponible no cuenta como confirmación');

  console.log('Caso E (Caja alcista + Nikkei con dato faltante):');
  console.log(`  confianza = ${v2E.confianza} (el filtro sin dato no opina)\n`);

  console.log(`Producción: FILTROS_ACTIVOS = ${JSON.stringify(FILTROS_ACTIVOS)} (solo los que pasaron Bonferroni) | penalidad = ${PENALIDAD_POR_FACTOR_EN_CONTRA} pts/factor en contra`);
  console.log('');
  console.log('OK: la arquitectura señal primaria + filtros funciona — la Caja overnight manda, los filtros solo atenúan (nunca revierten), y los factores sin Bonferroni no pueden vetar.');
}

run();
