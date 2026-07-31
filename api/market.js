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

async function fetchYahooChart(symbol, range = '1d', interval = '1m') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.chart?.result?.[0] || null;
  } catch (e) {
    return null;
  }
}

async function fetchQuote(symbol) {
  const chart = await fetchYahooChart(symbol, '1d', '1m');
  if (!chart || !chart.meta) return null;
  const { meta } = chart;
  const price = meta.regularMarketPrice;
  const prev = meta.previousClose || meta.chartPreviousClose;
  return {
    price,
    change: prev ? ((price - prev) / prev) * 100 : null,
    previousClose: prev,
    name: meta.shortName || meta.longName || symbol
  };
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

  // Sanity check: KOSPI real está entre 1000-4000. Yahoo devuelve datos corruptos (^KS11 > 5000)
  if (results.kospi && (results.kospi.price > 4000 || results.kospi.price < 1000)) {
    console.warn(`KOSPI corrupto (${results.kospi.price}), usando valor neutral`);
    results.kospi = { price: 2600, change: 0, previousClose: 2600, name: 'KOSPI (estimado)', _invalid: true };
  }

  // Fear & Greed: proxy basado en VIX (CNN bloquea bots con 418)
  results.fearGreed = await fetchFearGreed(results.vix?.price);

  return results;
}

module.exports = { fetchMarketData, fetchHistorical, fetchQuote, SYMBOLS };
