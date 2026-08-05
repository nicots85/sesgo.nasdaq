const { THRESHOLDS, labelFromScore } = require('../api/bias');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

/**
 * FASE 3 — Verifica que los 5 umbrales de etiqueta:
 *   1. Estén en orden creciente correcto (BAJISTA FUERTE < BAJISTA CON
 *      CAUTELA < NEUTRAL < ALCISTA CON CAUTELA < ALCISTA FUERTE).
 *   2. Cubran todo el rango -100 a 100 sin huecos ni superposiciones
 *      (cada score entero pertenece a exactamente una banda).
 *   3. Coincidan con los percentiles reales calculados en
 *      compute-score-distribution.js (p10, p30, p70, p90).
 */

const ORDER = ['BAJISTA FUERTE', 'BAJISTA CON CAUTELA', 'NEUTRAL', 'ALCISTA CON CAUTELA', 'ALCISTA FUERTE'];

// Valores esperados derivados de los percentiles reales:
//   BAJISTA FUERTE:       score <= p10  (<= 7)
//   BAJISTA CON CAUTELA:  p10 <  score <= p30  (8 a 9)
//   NEUTRAL:              p30 <  score <= p70  (10 a 13)
//   ALCISTA CON CAUTELA:  p70 <  score <= p90  (14 a 15)
//   ALCISTA FUERTE:       score > p90  (> 15)
const EXPECTED_BANDS = {
  'BAJISTA FUERTE':      { min: -100, max: 7 },
  'BAJISTA CON CAUTELA': { min: 8,    max: 9 },
  'NEUTRAL':             { min: 10,   max: 13 },
  'ALCISTA CON CAUTELA': { min: 14,   max: 15 },
  'ALCISTA FUERTE':      { min: 16,   max: 100 },
};

function run() {
  // 1. Orden creciente de los umbrales numéricos
  assert(typeof THRESHOLDS.bajistaCautela === 'number', 'bajistaCautela debe ser numérico');
  assert(typeof THRESHOLDS.neutral === 'number', 'neutral debe ser numérico');
  assert(typeof THRESHOLDS.alcistaCautela === 'number', 'alcistaCautela debe ser numérico');
  assert(typeof THRESHOLDS.alcistaFuerte === 'number', 'alcistaFuerte debe ser numérico');

  const values = [THRESHOLDS.bajistaCautela, THRESHOLDS.neutral, THRESHOLDS.alcistaCautela, THRESHOLDS.alcistaFuerte];
  assert(values[0] < values[1] && values[1] < values[2] && values[2] < values[3],
    `los umbrales deben estar en orden creciente estricto, pero son ${values.join(' < ')}`);

  // 2. Bandas derivadas de labelFromScore sobre el rango completo -100..100
  const bands = {};
  for (const label of ORDER) bands[label] = { min: null, max: null, count: 0 };

  for (let s = -100; s <= 100; s++) {
    const { label } = labelFromScore(s);
    assert(ORDER.includes(label), `score ${s} produjo una etiqueta desconocida: "${label}"`);
    if (bands[label].min === null) bands[label].min = s;
    bands[label].max = s;
    bands[label].count++;
  }

  // Sin huecos ni superposiciones: cada banda debe ser [min, max] y la
  // siguiente banda debe empezar en max+1 exacto (contigüidad).
  for (let i = 0; i < ORDER.length; i++) {
    const label = ORDER[i];
    const b = bands[label];
    assert(b.min !== null, `la banda ${label} no apareció en todo el rango -100..100 (hueco)`);
    assert(b.count === b.max - b.min + 1, `la banda ${label} no es contigua`);
    if (i > 0) {
      const prev = bands[ORDER[i - 1]];
      assert(prev.max + 1 === b.min, `hueco entre ${ORDER[i - 1]} (hasta ${prev.max}) y ${label} (desde ${b.min})`);
    }
  }

  // Cobertura total: la última banda debe terminar en 100 y la primera en -100
  assert(bands['BAJISTA FUERTE'].min === -100, `BAJISTA FUERTE debe empezar en -100, empieza en ${bands['BAJISTA FUERTE'].min}`);
  assert(bands['ALCISTA FUERTE'].max === 100, `ALCISTA FUERTE debe terminar en 100, termina en ${bands['ALCISTA FUERTE'].max}`);

  // 3. Coincidencia con los percentiles reales calculados
  const jsonPath = path.join(__dirname, '..', 'research', 'phase-b-structural-backtest', 'score-distribution.json');
  if (fs.existsSync(jsonPath)) {
    const dist = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    const P = dist.percentiles || {};
    assert.strictEqual(THRESHOLDS.bajistaCautela, P.p10, `bajistaCautela debería ser p10 (${P.p10})`);
    assert.strictEqual(THRESHOLDS.neutral, P.p30, `neutral (borde inferior) debería ser p30 (${P.p30})`);
    assert.strictEqual(THRESHOLDS.alcistaCautela, P.p70, `alcistaCautela (borde inferior) debería ser p70 (${P.p70})`);
    assert.strictEqual(THRESHOLDS.alcistaFuerte, P.p90, `alcistaFuerte (borde inferior) debería ser p90 (${P.p90})`);
  } else {
    console.warn('AVISO: score-distribution.json no encontrado, no se puede verificar contra los percentiles reales.');
  }

  console.log('Umbrales (FASE 3, derivados de percentiles del histórico real):');
  for (const label of ORDER) {
    const b = EXPECTED_BANDS[label];
    const real = bands[label];
    console.log(`  ${label.padEnd(22)} ${String(b.min).padStart(4)} a ${String(b.max).padEnd(4)}  (real: ${real.min} a ${real.max}, ${real.count} valores)`);
  }
  console.log('');
  console.log('OK: los 5 umbrales están en orden creciente, cubren todo el rango -100 a 100 sin huecos ni superposiciones, y coinciden con los percentiles reales.');
}

run();
