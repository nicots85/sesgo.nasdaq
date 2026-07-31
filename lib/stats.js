function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function pearsonR(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return { r: 0, n };
  const sx = x.slice(0, n);
  const sy = y.slice(0, n);
  const mx = mean(sx);
  const my = mean(sy);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = sx[i] - mx;
    const dy = sy[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const den = Math.sqrt(dx2 * dy2);
  return { r: den === 0 ? 0 : num / den, n };
}

function rSquared(r) {
  return r * r;
}

function tCDF(t, df) {
  const x = df / (df + t * t);
  return 1 - 0.5 * regIncBeta(x, df / 2, 0.5);
}

function regIncBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnBeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta) / a;
  let sum = 1, term = 1;
  for (let i = 1; i < 200; i++) {
    term *= (i - b) * x / (a + i);
    sum += term;
    if (Math.abs(term) < 1e-12) break;
  }
  return front * sum;
}

function lnGamma(z) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z, y = z, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

function pValueR(r, n) {
  if (n <= 2 || Math.abs(r) >= 1) return r > 0 ? 0 : 1;
  const t = r * Math.sqrt((n - 2) / (1 - r * r));
  return 2 * (1 - tCDF(Math.abs(t), n - 2));
}

function rollingCorrelation(x, y, window) {
  const result = [];
  for (let i = window - 1; i < Math.min(x.length, y.length); i++) {
    const sx = x.slice(i - window + 1, i + 1);
    const sy = y.slice(i - window + 1, i + 1);
    result.push(pearsonR(sx, sy).r);
  }
  return result;
}

function adfTest(series) {
  const n = series.length;
  if (n < 10) return { stat: 0, n };
  const y = series.slice(1);
  const yLag = series.slice(0, -1);
  const deltaY = y.map((v, i) => v - yLag[i]);
  const mDY = mean(deltaY);
  const mYL = mean(yLag);
  let num = 0, den = 0;
  for (let i = 0; i < n - 1; i++) {
    num += (yLag[i] - mYL) * (deltaY[i] - mDY);
    den += (yLag[i] - mYL) ** 2;
  }
  if (den === 0) return { stat: 0, n };
  const beta = num / den;
  const alpha = mDY - beta * mYL;
  const residuals = deltaY.map((d, i) => d - alpha - beta * yLag[i]);
  const sse = residuals.reduce((a, r) => a + r * r, 0);
  const se = Math.sqrt(sse / (n - 3));
  const seBeta = se / Math.sqrt(den);
  return { stat: seBeta === 0 ? 0 : beta / seBeta, n };
}

function engleGranger(seriesA, seriesB) {
  const n = Math.min(seriesA.length, seriesB.length);
  if (n < 20) return { testStat: 0, isCointegrated: false, confidence: 'baja' };
  const a = seriesA.slice(-n);
  const b = seriesB.slice(-n);
  const mA = mean(a);
  const mB = mean(b);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (b[i] - mB) * (a[i] - mA);
    den += (b[i] - mB) ** 2;
  }
  if (den === 0) return { testStat: 0, isCointegrated: false, confidence: 'baja' };
  const beta = num / den;
  const alpha = mA - beta * mB;
  const residuals = a.map((v, i) => v - (alpha + beta * b[i]));
  const adf = adfTest(residuals);
  
  // Valores críticos Engle-Granger ajustados por n (MacKinnon approx)
  // 10%: -2.57, 5%: -2.86, 1%: -3.43 (para n=100)
  // Para n=252 son aprox -2.58, -2.89, -3.50
  // Usamos interpolación simple
  const cv10 = -2.57 - 0.01 * Math.max(0, n - 100) / 100;
  const cv05 = -2.86 - 0.03 * Math.max(0, n - 100) / 100;
  const cv01 = -3.43 - 0.07 * Math.max(0, n - 100) / 100;
  
  const isCoint = adf.stat < cv10;
  const conf = adf.stat < cv01 ? 'alta' : adf.stat < cv05 ? 'media' : 'baja';
  return { testStat: Math.round(adf.stat * 10000) / 10000, isCointegrated: isCoint, confidence: conf, criticalValues: { '10%': cv10, '5%': cv05, '1%': cv01 } };
}

function logReturns(prices) {
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0 && prices[i] > 0) {
      returns.push(Math.log(prices[i] / prices[i - 1]));
    }
  }
  return returns;
}

function standardDev(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, v) => a + (v - m) ** 2, 0) / arr.length);
}

module.exports = { pearsonR, rSquared, pValueR, rollingCorrelation, engleGranger, logReturns, mean, standardDev };
