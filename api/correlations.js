const { pearsonR, rSquared, pValueR, rollingCorrelation, engleGranger, logReturns } = require('../lib/stats');

const PAIRS = [
  ['nikkei', 'nasdaq', 'Nikkei ↔ Nasdaq'],
  ['nikkei', 'sp500', 'Nikkei ↔ S&P 500'],
  ['nikkei', 'vix', 'Nikkei ↔ VIX'],
  ['nikkei', 'usdjpy', 'Nikkei ↔ USD/JPY'],
  ['kospi', 'nasdaq', 'KOSPI ↔ Nasdaq'],
  ['kospi', 'sp500', 'KOSPI ↔ S&P 500'],
  ['kospi', 'vix', 'KOSPI ↔ VIX'],
  ['kospi', 'usdjpy', 'KOSPI ↔ USD/JPY'],
  ['vix', 'nasdaq', 'VIX ↔ Nasdaq'],
  ['vix', 'sp500', 'VIX ↔ S&P 500'],
  ['dxy', 'sp500', 'DXY ↔ S&P 500'],
  ['dxy', 'nasdaq', 'DXY ↔ Nasdaq'],
  ['dxy', 'usdjpy', 'DXY ↔ USD/JPY'],
  ['usdjpy', 'nasdaq', 'USD/JPY ↔ Nasdaq'],
  ['wti', 'nasdaq', 'WTI ↔ Nasdaq']
];

function interpretCorrelation(r, pairLabel) {
  const abs = Math.abs(r);
  const dir = r > 0 ? 'positiva' : 'negativa';
  if (abs > 0.7) return `Fuerte ${dir} (${(abs * 100).toFixed(0)}%)`;
  if (abs > 0.5) return `Moderada ${dir} (${(abs * 100).toFixed(0)}%)`;
  if (abs > 0.3) return `Débil ${dir} (${(abs * 100).toFixed(0)}%)`;
  return `Sin relación significativa`;
}

function calculateCorrelations(pricesMap) {
  const results = {};

  for (const [a, b, label] of PAIRS) {
    const key = `${a}__${b}`;
    const pricesA = pricesMap[a];
    const pricesB = pricesMap[b];

    if (!pricesA || !pricesB || pricesA.length < 30 || pricesB.length < 30) {
      results[key] = { label, error: 'datos insuficientes' };
      continue;
    }

    const len = Math.min(pricesA.length, pricesB.length);
    const sliceA = pricesA.slice(-len);
    const sliceB = pricesB.slice(-len);
    const retA = logReturns(sliceA);
    const retB = logReturns(sliceB);

    const full = pearsonR(retA, retB);
    const r20 = rollingCorrelation(retA, retB, 20);
    const r60 = rollingCorrelation(retA, retB, 60);

    const annualSliceA = pricesA.slice(-252);
    const annualSliceB = pricesB.slice(-252);
    const annualRetA = logReturns(annualSliceA);
    const annualRetB = logReturns(annualSliceB);
    const annual = pearsonR(annualRetA, annualRetB);

    const coint = engleGranger(sliceA, sliceB);

    results[key] = {
      label,
      r: Math.round(full.r * 1000) / 1000,
      rSquared: Math.round(rSquared(full.r) * 1000) / 1000,
      pValue: Math.round(pValueR(full.r, full.n) * 10000) / 10000,
      significant: pValueR(full.r, full.n) < 0.05,
      nObs: full.n,
      rolling_20d: r20.length > 0 ? Math.round(r20[r20.length - 1] * 1000) / 1000 : null,
      rolling_60d: r60.length > 0 ? Math.round(r60[r60.length - 1] * 1000) / 1000 : null,
      annual: Math.round(annual.r * 1000) / 1000,
      cointegration: coint,
      interpretation: interpretCorrelation(full.r, label),
      rollingHistory: r60
    };
  }

  return results;
}

module.exports = { calculateCorrelations, PAIRS };
