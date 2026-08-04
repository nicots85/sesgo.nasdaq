/**
 * Fetcher independiente de histórico diario, SOLO para este backtest de
 * investigación (Fase B). No modifica ni depende de las funciones de
 * fetch de producción en api/market.js (que usan rango de 1 año) —
 * acá usamos 2 años para tener más muestra.
 *
 * No se conecta a internet en este sandbox de desarrollo — ejecutar en
 * un entorno con salida de red real (ej. nicots, o localmente).
 */
const SYMBOLS = {
  nikkei: '^N225',
  kospi: '^KS11',
  nasdaq: '^NDX',
  sp500: '^GSPC',
  vix: '^VIX',
  dxy: 'DX-Y.NYB',
  usdjpy: 'JPY=X',
  wti: 'CL=F'
};

async function fetchYahooDaily(symbol, range = '2y') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result || !result.timestamp) return null;
    const ts = result.timestamp;
    const closes = result.indicators.quote[0].close;
    return ts
      .map((t, i) => ({ date: new Date(t * 1000).toISOString().split('T')[0], close: closes[i] }))
      .filter(d => d.close != null);
  } catch (e) {
    console.warn(`Fallo al bajar ${symbol}:`, e.message);
    return null;
  }
}

/**
 * Baja los 8 símbolos y devuelve un Map<date, {nikkei, kospi, nasdaq, ...}>
 * SOLO con las fechas donde los 8 símbolos tienen dato (intersección) —
 * necesario porque Nikkei/KOSPI tienen feriados distintos a EE.UU.
 */
async function fetchAllAligned(range = '2y') {
  const raw = {};
  for (const [name, symbol] of Object.entries(SYMBOLS)) {
    console.log(`Bajando ${name} (${symbol})...`);
    raw[name] = await fetchYahooDaily(symbol, range);
    if (!raw[name]) throw new Error(`No se pudo bajar ${name} (${symbol}) — revisar conexión o símbolo`);
    console.log(`  ${raw[name].length} días recibidos`);
  }

  // Intersección de fechas presentes en TODOS los símbolos
  const dateSets = Object.values(raw).map(arr => new Set(arr.map(d => d.date)));
  const commonDates = [...dateSets[0]].filter(d => dateSets.every(s => s.has(d))).sort();

  const byDate = {};
  for (const date of commonDates) {
    byDate[date] = {};
    for (const [name, arr] of Object.entries(raw)) {
      byDate[date][name] = arr.find(d => d.date === date).close;
    }
  }

  console.log(`\nFechas alineadas (presentes en los 8 símbolos): ${commonDates.length}`);
  return { byDate, dates: commonDates, raw };
}

module.exports = { SYMBOLS, fetchYahooDaily, fetchAllAligned };
