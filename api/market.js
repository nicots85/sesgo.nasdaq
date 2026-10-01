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

function withTimeout(promise, ms) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
  return Promise.race([promise, timeout]);
}

const YAHOO_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
const YAHOO_BUDGET_MS = 8000; // tope total por activo (Vercel corta cerca de 10 s)

// Último resultado bueno por activo (vive mientras la función esté "caliente").
// Si Yahoo falla justo ahora, se usa el último dato bueno marcado como _stale
// en vez de dejar el factor vacío.
const lastGood = new Map();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchYahooChart(symbol, range = '1d', interval = '1m') {
  const deadline = Date.now() + YAHOO_BUDGET_MS;
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  // Hasta 4 intentos alternando servidor; reintenta ante error de red, 429 o 5xx.
  for (let attempt = 0; attempt < 4; attempt++) {
    const left = deadline - Date.now();
    if (left < 1000) break;
    const host = YAHOO_HOSTS[attempt % YAHOO_HOSTS.length];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(4000, left));
    try {
      const res = await fetch(`https://${host}${path}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        const result = data?.chart?.result?.[0] || null;
        if (result) return result;
      } else if (res.status !== 429 && res.status < 500) {
        return null; // 4xx real (ej. símbolo inexistente): no tiene sentido reintentar
      }
    } catch (e) {
      clearTimeout(timer);
    }
    await sleep(300 * (attempt + 1));
  }
  return null;
}

async function fetchQuote(symbol) {
  const chart = await fetchYahooChart(symbol, '1d', '1m');
  if (!chart || !chart.meta) {
    const prev = lastGood.get(symbol);
    return prev ? { ...prev, _stale: true } : null;
  }
  const { meta } = chart;
  const price = meta.regularMarketPrice;
  const prev = meta.previousClose || meta.chartPreviousClose;
  const quote = {
    price,
    change: prev ? ((price - prev) / prev) * 100 : null,
    previousClose: prev,
    name: meta.shortName || meta.longName || symbol
  };
  if (price != null) lastGood.set(symbol, quote);
  return quote;
}

async function fetchHistorical(symbol, days = 252) {
  const chart = await fetchYahooChart(symbol, '1y', '1d');
  if (!chart || !chart.timestamp || !chart.indicators) return [];
  const ts = chart.timestamp;
  const closes = chart.indicators.quote[0].close;
  if (!closes) return [];
  return ts
    .map((t, i) => ({ date: new Date(t * 1000).toISOString().split('T')[0], close: closes[i] }))
    .filter(d => d.close != null)
    .slice(-days);
}

async function fetchFearGreed(vixPrice) {
  if (vixPrice == null) return null;
  let value, label;
  if (vixPrice <= 12) { value = 90; label = 'Codicia extrema'; }
  else if (vixPrice <= 15) { value = 75; label = 'Codicia'; }
  else if (vixPrice <= 19) { value = 55; label = 'Neutral'; }
  else if (vixPrice <= 24) { value = 35; label = 'Miedo'; }
  else if (vixPrice <= 30) { value = 20; label = 'Miedo'; }
  else { value = 10; label = 'Miedo extremo'; }
  return { value, label };
}

async function fetchMarketData() {
  const results = {};

  const fetches = Object.entries(SYMBOLS).map(async ([name, symbol]) => {
    results[name] = await fetchQuote(symbol);
  });

  await Promise.allSettled(fetches);

  // Sanity check: KOSPI real en 2026 cotiza entre ~4500 y ~9000 (subió
  // de los 2500-3000 de años previos). Yahoo puede devolver datos
  // corruptos fuera de todo rango plausible. El rango se mantiene amplio
  // para no descartar el dato real si el índice sigue subiendo.
  if (results.kospi && (results.kospi.price > 12000 || results.kospi.price < 2000)) {
    console.warn(`KOSPI corrupto (${results.kospi.price}), usando valor neutral`);
    results.kospi = { price: 2600, change: 0, previousClose: 2600, name: 'KOSPI (estimado)', _invalid: true };
  }

  // Fear & Greed: proxy basado en VIX (CNN bloquea bots con 418)
  results.fearGreed = await fetchFearGreed(results.vix?.price);

  return results;
}

module.exports = { fetchMarketData, fetchHistorical, fetchQuote, SYMBOLS };
