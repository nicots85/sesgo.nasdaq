/**
 * FASE 2 — Backtest factor por factor (test de edge individual)
 *
 * A diferencia de run-phase-b.js (que testea el score ponderado completo),
 * este script testea CADA factor de forma aislada: construye la serie de
 * scores de un factor SOLO y mide si predice el retorno diario del Nasdaq.
 *
 * Motor de datos: reutiliza fetchAllAligned() de fetch-daily-history.js
 * (NO se reimplementa). Regla de lag anti-look-ahead idéntica a
 * run-phase-b.js:
 *   - Nikkei, KOSPI: dato del MISMO día D (cierran antes que NY → pre-market)
 *   - VIX, DXY, WTI: NIVEL del día D-1
 *   - USD/JPY, S&P 500: CAMBIO del día D-1 (D-1 vs D-2)
 *   - Nasdaq momentum (lag 1 día, CANDIDATO): CAMBIO del día D-1 — la
 *     versión NO circular del viejo "Momentum Nasdaq" (eliminado del
 *     score en Fase 1.5 por circularidad)
 *
 * SCORES: se importan de api/bias.js (scoreVix, scoreDxy, etc.) — las
 * MISMAS reglas puras que usa producción. No hay dos versiones.
 *
 * CORRECCIÓN POR COMPARACIONES MÚLTIPLES:
 *   - Los 7 factores estructurales: Bonferroni 0.05/7 ≈ 0.0071
 *   - El candidato "Nasdaq momentum (lag 1)": al ser una octava prueba,
 *     se usa 0.05/8 ≈ 0.00625 (más conservador). Se reporta por
 *     separado porque NO forma parte del score ponderado.
 *
 * NOTA Nikkei/KOSPI: el score usa el estado de cointegración calculado
 * una sola vez sobre toda la muestra (misma simplificación que
 * run-phase-b.js). Si un factor no está cointegrado, su score se fuerza
 * a 0 en producción — acá se replica para medir el edge tal como se usa.
 */
const { scoreVix, scoreDxy, scoreUsdjpy, scoreNikkei, scoreKospi, scoreSp500, scoreWti } = require('../../api/bias');
const { engleGranger, pearsonR, pValueR } = require('../../lib/stats');
const { fetchAllAligned } = require('./fetch-daily-history');

function pctChange(curr, prev) {
  if (prev == null || curr == null || prev === 0) return null;
  return ((curr - prev) / prev) * 100;
}

// Candidato NO circular (no está en producción): momentum del día D-1.
function scoreNasdaqMom(c) {
  return c > 1.5 ? 80 : c > 0.5 ? 40 : c > 0.2 ? 15 :
    c < -1.5 ? -80 : c < -0.5 ? -40 : c < -0.2 ? -15 : 0;
}

// Umbrales de Bonferroni
const BONF_7 = 0.05 / 7; // ≈ 0.0071, para los 7 estructurales
const BONF_8 = 0.05 / 8; // ≈ 0.00625, para el candidato (octava prueba)

// Los 7 estructurales + 1 candidato. `raw` define cómo se extrae el dato:
//   'level-D1'  → nivel del activo en D-1
//   'change-D1' → % de cambio D-1 vs D-2
//   'change-D'  → % de cambio D vs D-1 (solo Nikkei/KOSPI, pre-market legítimo)
const FACTORS = [
  { name: 'VIX',              raw: 'level-D1',  get: r => r.vixLvl,          score: scoreVix,     correction: BONF_7 },
  { name: 'DXY (Dólar)',      raw: 'level-D1',  get: r => r.dxyLvl,          score: scoreDxy,     correction: BONF_7 },
  { name: 'USD/JPY',          raw: 'change-D1', get: r => r.usdjpyChg,       score: scoreUsdjpy,  correction: BONF_7 },
  { name: 'Nikkei',           raw: 'change-D',  get: r => r.nikkeiChg,       score: (c) => scoreNikkei(c, null), correction: BONF_7, coint: 'nikkei' },
  { name: 'KOSPI',            raw: 'change-D',  get: r => r.kospiChg,        score: (c) => scoreKospi(c, null),  correction: BONF_7, coint: 'kospi' },
  { name: 'S&P 500',          raw: 'change-D1', get: r => r.sp500Chg,        score: scoreSp500,   correction: BONF_7 },
  { name: 'Crudo (WTI)',      raw: 'level-D1',  get: r => r.wtiLvl,          score: scoreWti,     correction: BONF_7 },
  { name: 'Nasdaq momentum (lag 1 día) [candidato]', raw: 'change-D1', get: r => r.nasdaqMomChg, score: scoreNasdaqMom, correction: BONF_8, candidato: true },
];

// Aproximación de la CDF normal estándar (p-value del test binomial)
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

  // Cointegración Nikkei/KOSPI: UNA vez sobre toda la muestra (como run-phase-b.js)
  const nikkeiSeries = dates.map(d => byDate[d].nikkei);
  const kospiSeries = dates.map(d => byDate[d].kospi);
  const nasdaqSeries = dates.map(d => byDate[d].nasdaq);
  const nikkeiCoint = engleGranger(nikkeiSeries, nasdaqSeries).isCointegrated;
  const kospiCoint = engleGranger(kospiSeries, nasdaqSeries).isCointegrated;

  // Inyectamos la cointegración en los score de Nikkei/KOSPI
  const FACTORS_RES = FACTORS.map(f => {
    if (f.coint === 'nikkei') return { ...f, score: (c) => scoreNikkei(c, nikkeiCoint) };
    if (f.coint === 'kospi') return { ...f, score: (c) => scoreKospi(c, kospiCoint) };
    return f;
  });

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
  console.log(`Cointegración: Nikkei↔Nasdaq=${nikkeiCoint ? 'SÍ' : 'no'} | KOSPI↔Nasdaq=${kospiCoint ? 'SÍ' : 'no'}`);
  console.log(`Umbral Bonferroni: estructurales 0.05/7=${BONF_7.toFixed(5)} | candidato 0.05/8=${BONF_8.toFixed(5)}\n`);

  const rows = FACTORS_RES.map(f => {
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
      candidato: !!f.candidato,
      cointegrado: f.coint ? (f.coint === 'nikkei' ? nikkeiCoint : kospiCoint) : null,
      correlacion: {
        r: Math.round(corr.r * 1000) / 1000,
        n: corr.n,
        pValue: Math.round(pval * 10000) / 10000,
        bonferroni: f.correction,
        pasaBonferroni: pval < f.correction,
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

  // Ordenado de mayor a menor evidencia (p crudo ascendente)
  const sorted = rows.slice().sort((a, b) => a.correlacion.pValue - b.correlacion.pValue);

  console.log('FACTOR | r | p crudo | Bonferroni | pasaBonf | Acierto% | N');
  console.log('------|---|---------|------------|----------|----------|---');
  for (const row of sorted) {
    const cand = row.candidato ? ' [cand]' : '';
    const coint = row.cointegrado == null ? '' : (row.cointegrado ? ' (coint)' : ' (no coint)');
    console.log(
      `${row.factor}${cand}${coint} | ${row.correlacion.r} | ${row.correlacion.pValue} | ${row.correlacion.bonferroni.toFixed(4)} | ${row.correlacion.pasaBonferroni ? 'SÍ' : 'no'} | ${row.aciertoDireccional.pct ?? '—'} | ${row.aciertoDireccional.n}`
    );
  }

  return { rows: sorted, records, nikkeiCoint, kospiCoint, BONF_7, BONF_8 };
}

if (require.main === module) {
  runPhaseBPerFactor().catch(e => {
    console.error('Error corriendo Fase 2:', e);
    process.exit(1);
  });
}

module.exports = { runPhaseBPerFactor, scoreNasdaqMom, pctChange, BONF_7, BONF_8 };
