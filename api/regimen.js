// api/regimen.js — Régimen de mercado en 5m y 15m con ADX + EMAs + Bollinger Bandwidth

function calcEMA(values, period) {
  const k = 2 / (period + 1);
  const ema = new Array(values.length);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  ema[period - 1] = sum / period;

  for (let i = period; i < values.length; i++) {
    ema[i] = values[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

function calcADX(candles, period = 14) {
  const n = candles.length;
  if (n < period * 2) return null;

  const tr = new Array(n);
  const plusDM = new Array(n);
  const minusDM = new Array(n);

  tr[0] = candles[0].high - candles[0].low;
  plusDM[0] = 0;
  minusDM[0] = 0;

  for (let i = 1; i < n; i++) {
    const highDiff = candles[i].high - candles[i - 1].high;
    const lowDiff = candles[i - 1].low - candles[i].low;

    plusDM[i] = highDiff > lowDiff && highDiff > 0 ? highDiff : 0;
    minusDM[i] = lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0;

    const hl = candles[i].high - candles[i].low;
    const hc = Math.abs(candles[i].high - candles[i - 1].close);
    const lc = Math.abs(candles[i].low - candles[i - 1].close);
    tr[i] = Math.max(hl, hc, lc);
  }

  // Wilder's smoothing
  let trSmooth = 0;
  let plusDMSmooth = 0;
  let minusDMSmooth = 0;

  for (let i = 1; i <= period; i++) {
    trSmooth += tr[i];
    plusDMSmooth += plusDM[i];
    minusDMSmooth += minusDM[i];
  }

  const dx = [];

  for (let i = period + 1; i < n; i++) {
    trSmooth = trSmooth - trSmooth / period + tr[i];
    plusDMSmooth = plusDMSmooth - plusDMSmooth / period + plusDM[i];
    minusDMSmooth = minusDMSmooth - minusDMSmooth / period + minusDM[i];

    const plusDI = trSmooth > 0 ? (plusDMSmooth / trSmooth) * 100 : 0;
    const minusDI = trSmooth > 0 ? (minusDMSmooth / trSmooth) * 100 : 0;
    const diDiff = Math.abs(plusDI - minusDI);
    const diSum = plusDI + minusDI;
    dx.push(diSum > 0 ? (diDiff / diSum) * 100 : 0);
  }

  if (dx.length < period) return null;

  let adx = 0;
  for (let i = 0; i < period; i++) adx += dx[i];
  adx /= period;

  for (let i = period; i < dx.length; i++) {
    adx = (adx * (period - 1) + dx[i]) / period;
  }

  return adx;
}

function calcBollingerBandwidth(closes, period = 20, numStd = 2) {
  const bandwidths = [];
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
    const std = Math.sqrt(variance);
    const upper = mean + numStd * std;
    const lower = mean - numStd * std;
    const bandwidth = mean > 0 ? (upper - lower) / mean : 0;
    bandwidths.push(bandwidth);
  }
  return bandwidths;
}

async function fetchYahooCandles(symbol, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=60d&interval=${interval}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = await res.json();
    const quote = data?.chart?.result?.[0]?.indicators?.quote?.[0];
    if (!quote || !quote.close) return [];

    const candles = [];
    for (let i = 0; i < quote.close.length; i++) {
      const open = quote.open[i];
      const high = quote.high[i];
      const low = quote.low[i];
      const close = quote.close[i];
      if (open != null && high != null && low != null && close != null) {
        candles.push({ open, high, low, close });
      }
    }
    return candles;
  } catch (e) {
    return [];
  }
}

function classifyTimeframe(candles) {
  if (!candles || candles.length < 50) {
    return {
      regimen: 'SIN_DATOS',
      direccion: null,
      adx_valor: null,
      etiqueta: 'SIN_DATOS',
      velas_utilizadas: candles ? candles.length : 0
    };
  }

  const closes = candles.map(c => c.close);
  const adx = calcADX(candles, 14);
  if (adx == null) {
    return {
      regimen: 'SIN_DATOS',
      direccion: null,
      adx_valor: null,
      etiqueta: 'SIN_DATOS',
      velas_utilizadas: candles.length
    };
  }

  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);

  const lastIdx = closes.length - 1;
  const currentEma20 = ema20[lastIdx];
  const currentEma50 = ema50[lastIdx];
  const slopeEma20 = currentEma20 - ema20[lastIdx - 5];
  const slopeEma50 = currentEma50 - ema50[lastIdx - 5];

  const bandwidths = calcBollingerBandwidth(closes, 20, 2);
  const currentBw = bandwidths[bandwidths.length - 1];
  const bwMean20 =
    bandwidths.slice(-20).reduce((a, b) => a + b, 0) / Math.min(bandwidths.length, 20);
  const isBwExpanding = currentBw >= bwMean20;

  let isTrend = false;
  let reglaAplicada = null;
  if (adx >= 25) {
    isTrend = true;
    reglaAplicada = 'adx_alto';
  } else if (adx < 20) {
    isTrend = false;
    reglaAplicada = 'adx_bajo';
  } else {
    // Zona gris (20-25): desempate con Bollinger Bandwidth
    isTrend = isBwExpanding;
    reglaAplicada = 'desempate_bollinger';
  }

  let direccion = null;
  let regimen = isTrend ? 'TENDENCIAL' : 'RANGO';

  if (isTrend) {
    const isBull = currentEma20 > currentEma50 && slopeEma20 > 0 && slopeEma50 > 0;
    const isBear = currentEma20 < currentEma50 && slopeEma20 < 0 && slopeEma50 < 0;
    if (isBull) {
      direccion = 'ALCISTA';
    } else if (isBear) {
      direccion = 'BAJISTA';
    } else {
      direccion = 'SIN_DIRECCION_CLARA';
    }
  }

  let etiqueta;
  if (regimen === 'RANGO') {
    etiqueta = 'RANGO';
  } else if (direccion === 'ALCISTA') {
    etiqueta = 'TENDENCIAL ALCISTA';
  } else if (direccion === 'BAJISTA') {
    etiqueta = 'TENDENCIAL BAJISTA';
  } else {
    etiqueta = 'TENDENCIAL SIN DIRECCION CLARA';
  }

  return {
    regimen,
    direccion,
    adx_valor: Math.round(adx * 10) / 10,
    bb_bandwidth: currentBw != null ? Number(currentBw.toFixed(6)) : null,
    bb_bandwidth_promedio: bwMean20 != null ? Number(bwMean20.toFixed(6)) : null,
    regla_aplicada: reglaAplicada,
    etiqueta,
    velas_utilizadas: candles.length
  };
}

module.exports = async function handler(req, res) {
  try {
    const [candles5m, candles15m] = await Promise.all([
      fetchYahooCandles('^NDX', '5m'),
      fetchYahooCandles('^NDX', '15m')
    ]);

    const result = {
      '5m': classifyTimeframe(candles5m),
      '15m': classifyTimeframe(candles15m)
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
