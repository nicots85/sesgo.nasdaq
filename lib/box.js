/**
 * Motor de análisis de "cajas" (pre-market / Initial Balance) — port de
 * box_analysis.py a JavaScript, para integrarse al mismo proyecto Vercel.
 *
 * No hace fetch de datos. Recibe velas de 1 minuto ya descargadas
 * (ver api/box-capture.js) y calcula las estadísticas de
 * continuación/reversión.
 *
 * Instrumento recomendado: 'NQ=F' (futuro E-mini Nasdaq-100), porque a
 * diferencia de '^NDX' sí cotiza en pre-market (~24hs), igual que USTEC.
 *
 * Todas las ventanas se definen en huso horario de Nueva York
 * ('America/New_York'), sin importar en qué huso corra el servidor.
 */

const NY_TZ = 'America/New_York';

// Ventanas de mercado (hora de Nueva York), en minutos desde medianoche
const PREMARKET_START = 4 * 60;        // 04:00
const PREMARKET_END = 9 * 60 + 30;     // 09:30
const IB_START = 9 * 60 + 30;          // 09:30
const IB_END = 10 * 60 + 30;           // 10:30
const SESSION_CLOSE = 16 * 60;         // 16:00

// Mínimo de barras de 1 min para considerar la caja confiable
const MIN_BARS_PREMARKET = 60;   // ventana dura 330 min
const MIN_BARS_IB = 30;          // ventana dura 60 min

const nyFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: NY_TZ,
  hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit'
});

/**
 * Convierte un timestamp (ms epoch) a { dateKey: 'YYYY-MM-DD', minuteOfDay }
 * en huso horario de Nueva York.
 */
function nyParts(timestampMs) {
  const parts = nyFormatter.formatToParts(new Date(timestampMs));
  const get = (type) => parts.find(p => p.type === type).value;
  const y = get('year'), mo = get('month'), d = get('day');
  const hh = parseInt(get('hour'), 10);
  const mm = parseInt(get('minute'), 10);
  return { dateKey: `${y}-${mo}-${d}`, minuteOfDay: hh * 60 + mm };
}

/**
 * Agrupa un array de velas [{t, o, h, l, c}] (t en ms epoch) por día NY.
 * Devuelve un Map<dateKey, Array<vela con minuteOfDay agregado>>.
 */
function groupByNYDate(bars) {
  const byDate = new Map();
  for (const bar of bars) {
    const { dateKey, minuteOfDay } = nyParts(bar.t);
    if (!byDate.has(dateKey)) byDate.set(dateKey, []);
    byDate.get(dateKey).push({ ...bar, minuteOfDay });
  }
  for (const arr of byDate.values()) arr.sort((a, b) => a.minuteOfDay - b.minuteOfDay);
  return byDate;
}

function windowSlice(dayBars, start, end) {
  return dayBars.filter(b => b.minuteOfDay >= start && b.minuteOfDay < end);
}

/**
 * Calcula el máximo/mínimo de una ventana horaria para un día.
 */
function computeBox(dayBars, boxName, start, end, minBars) {
  const w = windowSlice(dayBars, start, end);
  const nBars = w.length;
  if (nBars === 0) {
    return { boxName, high: null, low: null, nBars: 0, datoInsuficiente: true };
  }
  const high = Math.max(...w.map(b => b.h));
  const low = Math.min(...w.map(b => b.l));
  return { boxName, high, low, nBars, datoInsuficiente: nBars < minBars };
}

/**
 * Dada una caja ya calculada, mira el resto de la sesión (desde el fin
 * de la ventana hasta el cierre) y clasifica ruptura + resultado.
 */
function classifyOutcome(dayBars, box, windowEnd) {
  if (box.datoInsuficiente || box.high === null) {
    return { ...box, breakout: null, resultado: null, magnitudPct: null };
  }

  const resto = windowSlice(dayBars, windowEnd, SESSION_CLOSE);
  if (resto.length === 0) {
    return { ...box, breakout: null, resultado: null, magnitudPct: null };
  }

  const maxResto = Math.max(...resto.map(b => b.h));
  const minResto = Math.min(...resto.map(b => b.l));
  const cierreSesion = resto[resto.length - 1].c;

  const rompioArriba = maxResto > box.high;
  const rompioAbajo = minResto < box.low;

  if (!rompioArriba && !rompioAbajo) {
    return { ...box, breakout: 'sin_ruptura', resultado: 'neutro', magnitudPct: 0 };
  }

  let direccion;
  if (rompioArriba && rompioAbajo) {
    const tArriba = resto.find(b => b.h > box.high).minuteOfDay;
    const tAbajo = resto.find(b => b.l < box.low).minuteOfDay;
    direccion = tArriba < tAbajo ? 'alcista' : 'bajista';
  } else {
    direccion = rompioArriba ? 'alcista' : 'bajista';
  }

  const referencia = direccion === 'alcista' ? box.high : box.low;
  let resultado;
  if (direccion === 'alcista') {
    resultado = cierreSesion > referencia ? 'continuacion' : 'reversion';
  } else {
    resultado = cierreSesion < referencia ? 'continuacion' : 'reversion';
  }
  const magnitudPct = ((cierreSesion - referencia) / referencia) * 100;

  return { ...box, breakout: direccion, resultado, magnitudPct };
}

/**
 * Corre el análisis de UNA caja sobre un array de velas de 1 minuto que
 * puede abarcar varios días. Devuelve un array con un resultado por día.
 */
function runBoxBacktest(bars, boxName, start, end, minBars) {
  const byDate = groupByNYDate(bars);
  const results = [];
  for (const [dateKey, dayBars] of byDate.entries()) {
    const box = computeBox(dayBars, boxName, start, end, minBars);
    const classified = classifyOutcome(dayBars, box, end);
    results.push({ date: dateKey, ...classified });
  }
  results.sort((a, b) => a.date.localeCompare(b.date));
  return results;
}

/**
 * Analiza un solo día ya cargado (bars de ese día), para el uso diario
 * en producción (capturar el resultado de HOY y agregarlo al historial).
 */
function analyzeSingleDay(bars) {
  const byDate = groupByNYDate(bars);
  if (byDate.size === 0) return null;
  // Se asume que 'bars' corresponde a un solo día de trading (con pre/post market)
  const entries = [...byDate.entries()].sort((a, b) => b[1].length - a[1].length);
  const [dateKey, dayBars] = entries[0];

  const overnightBox = computeBox(dayBars, 'overnight', PREMARKET_START, PREMARKET_END, MIN_BARS_PREMARKET);
  const overnight = classifyOutcome(dayBars, overnightBox, PREMARKET_END);

  const ibBox = computeBox(dayBars, 'ib', IB_START, IB_END, MIN_BARS_IB);
  const ib = classifyOutcome(dayBars, ibBox, IB_END);

  return { date: dateKey, overnight, ib };
}

/**
 * Genera el resumen estadístico: % continuación/reversión, N, magnitud.
 * Equivalente a summarize() en Python.
 */
function summarize(results) {
  const validos = results.filter(r => !r.datoInsuficiente);
  const excluidos = results.length - validos.length;

  const resumen = { nTotalDias: results.length, nExcluidosDatoInsuficiente: excluidos };

  for (const direccion of ['alcista', 'bajista']) {
    const sub = validos.filter(r => r.breakout === direccion);
    const n = sub.length;
    if (n === 0) {
      resumen[direccion] = { n: 0 };
      continue;
    }
    const cont = sub.filter(r => r.resultado === 'continuacion');
    const rev = sub.filter(r => r.resultado === 'reversion');
    resumen[direccion] = {
      n,
      pctContinuacion: round1((cont.length / n) * 100),
      pctReversion: round1((rev.length / n) * 100),
      magnitudMediaContinuacionPct: cont.length ? round3(mean(cont.map(r => r.magnitudPct))) : null,
      magnitudMediaReversionPct: rev.length ? round3(mean(rev.map(r => r.magnitudPct))) : null,
    };
  }

  const sinRuptura = validos.filter(r => r.breakout === 'sin_ruptura').length;
  resumen.sinRuptura = {
    n: sinRuptura,
    pctDelTotalValido: validos.length ? round1((sinRuptura / validos.length) * 100) : null,
  };

  return resumen;
}

/**
 * Análisis combinado: ¿la ruptura de la caja overnight se confirma
 * (misma dirección) dentro de la Initial Balance, o se rechaza?
 */
function sweepConfirmation(overnightResults, ibResults) {
  const ibByDate = new Map(ibResults.map(r => [r.date, r]));
  const comparables = [];

  for (const on of overnightResults) {
    const ib = ibByDate.get(on.date);
    if (!ib) continue;
    if (on.datoInsuficiente || ib.datoInsuficiente) continue;
    if (on.breakout !== 'alcista' && on.breakout !== 'bajista') continue;
    comparables.push({ overnight: on, ib });
  }

  const confirmado = comparables.filter(c => c.ib.breakout === c.overnight.breakout);
  const rechazado = comparables.filter(c =>
    c.ib.breakout && c.ib.breakout !== 'sin_ruptura' && c.ib.breakout !== c.overnight.breakout
  );

  const outcomeRate = (subset) => {
    const n = subset.length;
    if (n === 0) return { n: 0 };
    const cont = subset.filter(c => c.overnight.resultado === 'continuacion').length;
    return { n, pctContinuacionSesion: round1((cont / n) * 100) };
  };

  return {
    nDiasComparables: comparables.length,
    confirmadoPorIB: outcomeRate(confirmado),
    rechazadoPorIB: outcomeRate(rechazado),
  };
}

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function round1(n) { return Math.round(n * 10) / 10; }
function round3(n) { return Math.round(n * 1000) / 1000; }

module.exports = {
  NY_TZ, PREMARKET_START, PREMARKET_END, IB_START, IB_END, SESSION_CLOSE,
  MIN_BARS_PREMARKET, MIN_BARS_IB,
  nyParts, groupByNYDate, computeBox, classifyOutcome,
  runBoxBacktest, analyzeSingleDay, summarize, sweepConfirmation,
};
