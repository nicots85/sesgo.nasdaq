/**
 * FASE 2 — Backtest factor por factor (test de edge individual)
 *
 * A diferencia de run-phase-b.js (que testea el score ponderado completo),
 * este script testea CADA factor de forma aislada: construye la serie de
 * scores de un factor solo y mide si predice el retorno diario del Nasdaq.
 *
 * REGLA CONTRA LOOK-AHEAD BIAS (idéntica a run-phase-b.js):
 *   - Nikkei, KOSPI: dato del MISMO día D (cierran antes que Nueva York →
 *     información legítima de pre-market)
 *   - VIX, DXY, WTI: NIVEL del día D-1
 *   - USD/JPY, S&P 500: CAMBIO del día D-1 (D-1 vs D-2)
 *   - Nasdaq momentum (lag 1): CAMBIO del día D-1 (D-1 vs D-2) — esta es
 *     la versión NO circular del viejo "Momentum Nasdaq". La versión
 *     circular (día D, pre-market incluido) se eliminó del score en la
 *     Fase 1.5 porque usaba el mismo activo que el score describe.
 *
 * Outcome: retorno del Nasdaq de cierre a cierre del día D (D vs D-1).
 *
 * NOTA sobre Nikkei/KOSPI: su score se calcula con los umbrales, SIN
 * forzar a 0 por falta de cointegración (a diferencia de producción).
 * Acá lo que se mide es el edge de la señal del factor en sí; la
 * cointegración se muestra como columna informativa aparte.
 */
const { engleGranger, pearsonR, pValueR } = require('../../lib/stats');
const { fetchAllAligned } = require('./fetch-daily-history');

function pctChange(curr, prev) {
  if (prev == null || curr == null || prev === 0) return null;
  return ((curr - prev) / prev) * 100;
}

// --- Funciones de score: replican los umbrales de api/bias.js ---
function scoreVIX(p) { return p < 15 ? 80 : p < 17 ? 50 : p < 20 ? 10 : p < 25 ? -50 : -80; }
function scoreDXY(p) { return p < 99 ? 60 : p < 102 ? 10 : p < 104 ? -30 : -60; }
function scoreUSDJPY(c) { return c > 1 ? 50 : c > 0.3 ? 20 : c < -1.5 ? -80 : c < -0.5 ? -40 : 0; }
function scoreNikkei(c) { return c > 1 ? 60 : c > 0 ? 30 : c < -1 ? -60 : c < 0 ? -30 : 0; }
function scoreKOSPI(c) { return c > 1 ? 60 : c > 0 ? 30 : c < -1 ? -60 : c < 0 ? -30 : 0; }
function scoreSP500(c) { return c > 1 ? 50 : c > 0.3 ? 20 : c < -1 ? -50 : c < -0.3 ? -20 : 0; }
function scoreWTI(p) { return p > 100 ? -50 : p > 85 ? -20 : p > 70 ? -10 : p >= 60 ? 15 : 40; }
function scoreNasdaqMom(c) {
  return c > 1.5 ? 80 : c > 0.5 ? 40 : c > 0.2 ? 15 :
    c < -1.5 ? -80 : c < -0.5 ? -40 : c < -0.2 ? -15 : 0;
}

// Los 8 factores a testear. `raw` = cómo se extrae el dato bruto del día:
//   'level-D1'  → nivel del activo en D-1
//   'change-D1' → % de cambio D-1 vs D-2
//   'change-D'  → % de cambio D vs D-1 (solo Nikkei/KOSPI, legítimo pre-market)
const FACTORS = [
  { name: 'VIX',              raw: 'level-D1',  get: r => r.vixLvl,      score: scoreVIX },
  { name: 'DXY (Dólar)',      raw: 'level-D1',  get: r => r.dxyLvl,      score: scoreDXY },
  { name: 'USD/JPY',          raw: 'change-D1', get: r => r.usdjpyChg,   score: scoreUSDJPY },
  { name: 'Nikkei',           raw: 'change-D',  get: r => r.nikkeiChg,   score: scoreNikkei, coint: 'nikkei' },
  { name: 'KOSPI',            raw: 'change-D',  get: r => r.kospiChg,    score: scoreKOSPI,  coint: 'kospi' },
  { name: 'S&P 500',          raw: 'change-D1', get: r => r.sp500Chg,    score: scoreSP500 },
  { name: 'Crudo (WTI)',      raw: 'level-D1',  get: r => r.wtiLvl,      score: scoreWTI },
  { name: 'Nasdaq momentum (lag 1 día)', raw: 'change-D1', get: r => r.nasdaqMomChg, score: scoreNasdaqMom },
];

// Aproximación de la CDF normal estándar (para el p-value del test binomial)
function normalCdf(x) {
  return 1 - 0.5 * erfc(x / Math.SQRT2);
}
function erfc(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? 1 - y : 1 + y;
}

async function runPhaseBPerFactor(fetchFn = fetchAllAligned) {
  console.log('=== FASE 2: Backtest factor por factor ===\n');

  const { byDate, dates } = await fetchFn('2y');

  if (dates.length < 60) {
    console.error(`Muestra insuficiente: solo ${dates.length} días alineados. Se necesitan al menos 60-100.`);
    process.exit(1);
  }

  // Cointegración Nikkei/KOSPI (información, no condiciona el score acá)
  const nikkeiSeries = dates.map(d => byDate[d].nikkei);
  const kospiSeries = dates.map(d => byDate[d].kospi);
  const nasdaqSeries = dates.map(d => byDate[d].nasdaq);
  const nikkeiCoint = engleGranger(nikkeiSeries, nasdaqSeries).isCointegrated;
  const kospiCoint = engleGranger(kospiSeries, nasdaqSeries).isCointegrated;

  // Reconstrucción día por día (necesitamos hasta D-2 → arrancamos en i=2)
  const records = [];
  let excluidosPorDatoFaltante = 0;

  for (let i = 2; i < dates.length; i++) {
    const today = byDate[dates[i]];
    const prev = byDate[dates[i - 1]];
    const prev2 = byDate[dates[i - 2]];

    const r = {
      vixLvl: prev.vix,
      dxyLvl: prev.dxy,
      wtiLvl: prev.wti,
      usdjpyChg: pctChange(prev.usdjpy, prev2.usdjpy),
      sp500Chg: pctChange(prev.sp500, prev2.sp500),
      nikkeiChg: pctChange(today.nikkei, prev.nikkei),
      kospiChg: pctChange(today.kospi, prev.kospi),
      nasdaqMomChg: pctChange(prev.nasdaq, prev2.nasdaq),
      nasdaqReturn: pctChange(today.nasdaq, prev.nasdaq),
    };

    if (Object.values(r).some(v => v == null)) {
      excluidosPorDatoFaltante++;
      continue;
    }
    records.push(r);
  }

  console.log(`Días utilizables: ${records.length} (excluidos por dato faltante: ${excluidosPorDatoFaltante})`);
  console.log(`Cointegración: Nikkei↔Nasdaq=${nikkeiCoint ? 'SÍ' : 'no'} | KOSPI↔Nasdaq=${kospiCoint ? 'SÍ' : 'no'}\n`);

  const rows = FACTORS.map(f => {
    const scores = records.map(r => f.score(f.get(r)));
    const returns = records.map(r => r.nasdaqReturn);

    const corr = pearsonR(scores, returns);
    const pval = pValueR(corr.r, corr.n);

    const withSign = records
      .map((r, idx) => ({ s: scores[idx], ret: r.nasdaqReturn }))
      .filter(p => p.s !== 0 && p.ret !== 0);
    const nSign = withSign.length;
    const aciertos = withSign.filter(p => Math.sign(p.s) === Math.sign(p.ret)).length;
    const tasaAcierto = nSign > 0 ? (aciertos / nSign) * 100 : null;

    const seBinom = nSign > 0 ? Math.sqrt(0.25 / nSign) : null;
    const zScore = seBinom != null ? ((aciertos / nSign) - 0.5) / seBinom : null;
    const pValBinomAprox = zScore != null ? 2 * (1 - normalCdf(Math.abs(zScore))) : null;

    return {
      factor: f.name,
      raw: f.raw,
      cointegrado: f.coint ? (f.coint === 'nikkei' ? nikkeiCoint : kospiCoint) : null,
      correlacion: {
        r: Math.round(corr.r * 1000) / 1000,
        n: corr.n,
        pValue: Math.round(pval * 10000) / 10000,
        significativo: pval < 0.05,
      },
      aciertoDireccional: {
        n: nSign,
        aciertos,
        pct: tasaAcierto != null ? Math.round(tasaAcierto * 10) / 10 : null,
        pValueAprox: pValBinomAprox != null ? Math.round(pValBinomAprox * 10000) / 10000 : null,
        significativo: pValBinomAprox != null ? pValBinomAprox < 0.05 : null,
      },
    };
  });

  console.log(JSON.stringify(rows, null, 2));
  return { rows, records };
}

if (require.main === module) {
  runPhaseBPerFactor().catch(e => {
    console.error('Error corriendo Fase 2:', e);
    process.exit(1);
  });
}

module.exports = { runPhaseBPerFactor, scoreVIX, scoreDXY, scoreUSDJPY, scoreNikkei, scoreKOSPI, scoreSP500, scoreWTI, scoreNasdaqMom, pctChange };
