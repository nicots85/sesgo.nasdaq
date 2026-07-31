const box = require('../lib/box');
const assert = require('assert');

// Genera velas de 1 minuto sintéticas para un día, desde las 04:00 hasta
// las 15:59 hora de Nueva York, con patrones controlados.
function makeDay(dateStr, premarketRange, ibRange, postIbDrift) {
  // Arrancamos bien temprano en UTC para asegurarnos de cubrir 04:00-16:00 NY
  // sin importar si el día cae en horario de verano (EDT) o de invierno (EST).
  const [y, m, d] = dateStr.split('-').map(Number);
  const startUTC = Date.UTC(y, m - 1, d, 7, 0, 0); // cubre de sobra el arranque NY

  const bars = [];
  for (let i = 0; i < 780; i++) { // 13 horas de margen
    const t = startUTC + i * 60000;
    const { minuteOfDay } = box.nyParts(t); // usamos la MISMA conversión que el módulo real
    let price;
    if (minuteOfDay < box.PREMARKET_START || minuteOfDay >= box.SESSION_CLOSE) {
      continue; // fuera del rango que nos interesa, no generamos vela
    } else if (minuteOfDay < box.PREMARKET_END) {
      price = rand(premarketRange[0], premarketRange[1]);
    } else if (minuteOfDay < box.IB_END) {
      price = rand(ibRange[0], ibRange[1]);
    } else {
      const start = postIbDrift >= 0 ? ibRange[1] : ibRange[0];
      const progress = (minuteOfDay - box.IB_END) / (box.SESSION_CLOSE - box.IB_END);
      price = start + postIbDrift * progress + rand(-0.05, 0.05);
    }
    bars.push({ t, o: price, h: price + 0.02, l: price - 0.02, c: price });
  }
  return bars;
}

function rand(a, b) { return a + Math.random() * (b - a); }

function buildSyntheticDataset() {
  let all = [];
  // Los 25 días tienen la MISMA caja overnight (99.5-100.0) y el MISMO
  // rango de IB (100.1-100.3, ya por encima de la caja overnight), así
  // que en los 25 casos el breakout overnight clasifica como "alcista".
  // Lo único que cambia es el drift post-IB: +1.5 (continúa) o -1.5 (revierte).
  for (let i = 1; i <= 15; i++) {
    all = all.concat(makeDay(`2025-01-${String(i).padStart(2, '0')}`, [99.5, 100.0], [100.1, 100.3], 1.5));
  }
  for (let i = 1; i <= 10; i++) {
    all = all.concat(makeDay(`2025-02-${String(i).padStart(2, '0')}`, [99.5, 100.0], [100.1, 100.3], -1.5));
  }
  return all;
}

function run() {
  const bars = buildSyntheticDataset();

  const overnight = box.runBoxBacktest(bars, 'overnight', box.PREMARKET_START, box.PREMARKET_END, box.MIN_BARS_PREMARKET);
  const ib = box.runBoxBacktest(bars, 'ib', box.IB_START, box.IB_END, box.MIN_BARS_IB);

  const resumenOvernight = box.summarize(overnight);
  const resumenIb = box.summarize(ib);

  console.log('--- RESUMEN OVERNIGHT ---');
  console.log(JSON.stringify(resumenOvernight, null, 2));
  console.log('--- RESUMEN IB ---');
  console.log(JSON.stringify(resumenIb, null, 2));

  assert(resumenOvernight.alcista.n === 25, `Los 25 días deberían clasificar como ruptura alcista, dio ${resumenOvernight.alcista.n}`);
  assert(resumenOvernight.alcista.pctContinuacion === 60, `Se esperaba 60% de continuación (15/25), dio ${resumenOvernight.alcista.pctContinuacion}`);

  const combo = box.sweepConfirmation(overnight, ib);
  console.log('--- SWEEP + CONFIRMACIÓN ---');
  console.log(JSON.stringify(combo, null, 2));
  assert(combo.nDiasComparables > 0, 'Debería haber días comparables entre ambas cajas');

  console.log('\nOK: el port a JavaScript se comporta como se espera con datos sintéticos.');
}

run();
