const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');

// Datos de ejemplo realistas, con la misma forma que devuelve /api/bias
const mockData = {
  bias: {
    score: 42, label: 'Alcista con cautela', emoji: '🟢',
    factors: [
      { name: 'Caja overnight', score: 30, weight: 0.35 },
      { name: 'VIX', score: 55, weight: 0.15 },
      { name: 'DXY', score: -20, weight: 0.10 },
      { name: 'Nikkei', score: 60, weight: 0.10 },
      { name: 'KOSPI', score: 45, weight: 0.08 },
      { name: 'USD/JPY', score: -15, weight: 0.07 },
      { name: 'S&P 500', score: 50, weight: 0.06 },
      { name: 'WTI', score: 0, weight: 0.04 },
      { name: 'Fear & Greed', score: -10, weight: 0.03 },
      { name: 'Noticias', score: 25, weight: 0.13 },
    ]
  },
  market: {
    vix: { price: 17.1 }, dxy: { price: 100.19 },
    usdjpy: { price: 160.68, change: 0.72 },
    sp500: { price: 7437.63, change: 1.66 },
    nasdaq: { price: 25122.18, change: 2.78 },
    nikkei: { price: 41500, change: 5.2 },
    kospi: { price: 3100, change: 8.0 },
    wti: { price: 78.2 },
    fearGreed: { value: 39, label: 'Miedo' }
  },
  correlations: {
    dxy__nasdaq: { label: 'DXY ↔ Nasdaq', r: -0.42, rSquared: 0.18, pValue: 0.001, significant: true, cointegration: { isCointegrated: false }, rollingHistory: [0.1, 0.2, -0.3, -0.4] },
    vix__nasdaq: { label: 'VIX ↔ Nasdaq', r: -0.71, rSquared: 0.5, pValue: 0.0001, significant: true, cointegration: { isCointegrated: false }, rollingHistory: [-0.5, -0.6, -0.7] },
    vix__sp500: { label: 'VIX ↔ S&P 500', r: -0.75, rSquared: 0.56, pValue: 0.0001, significant: true, cointegration: { isCointegrated: false } },
    dxy__sp500: { label: 'DXY ↔ S&P 500', r: -0.3, rSquared: 0.09, pValue: 0.02, significant: true, cointegration: { isCointegrated: false } },
  },
  news: {
    analysis: {
      overall_score: 25, confidence: 'media',
      individual: [
        { title: 'La Fed sostiene tasas en 3.50-3.75%', score: 10, reason: 'Neutral, esperado por el mercado' },
        { title: 'BoJ mantiene postura dovish', score: -15, reason: 'Presiona al yen a la baja' },
      ],
      key_factor: 'El rebote de semiconductores asiáticos domina el sentimiento de hoy'
    },
    sources: { total: 12, english: 8, spanish: 4 }
  },
  biasHistory: [
    { date: '2026-07-28', score: -10, label: 'Neutral bajista' },
    { date: '2026-07-29', score: 5, label: 'Neutral' },
    { date: '2026-07-30', score: 35, label: 'Alcista' },
    { date: '2026-07-31', score: 42, label: 'Alcista con cautela' },
  ],
  boxSummary: {
    nDiasAcumulados: 1,
    overnight: { alcista: { n: 1, pctContinuacion: 0, magnitudMediaContinuacionPct: null } },
    ib: { alcista: { n: 0 } },
    sweepConfirmation: {}
  },
  alerts: [
    { severity: 'media', message: 'Cierre de mes: posible ruido de rebalanceo en el pre-market' }
  ]
};

async function run() {
  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'https://nasdaq-alpha.vercel.app/' });
  const { window } = dom;

  // Esperamos a que el script inline termine de definir todo, y frenamos
  // el fetch real (no hay red en este sandbox) para inyectar el mock a mano.
  await new Promise(r => setTimeout(r, 300));

  const errors = [];
  window.onerror = (msg) => errors.push(msg);

  try {
    window.renderHero(mockData.bias);
    window.renderQuickMetrics(mockData.market);
    window.renderFactors(mockData.bias);
    window.renderMetrics(mockData.market);
    window.renderCorrelations(mockData.correlations);
    window.renderNews(mockData.news.analysis, mockData.news.sources);
    window.renderHistory(mockData.biasHistory);
    window.renderBoxSummary(mockData.boxSummary);
    window.renderAlerts(mockData.alerts);
    window.document.getElementById('loadingState').style.display = 'none';
    window.document.getElementById('mainContent').style.display = 'block';
  } catch (e) {
    errors.push(e.stack);
  }

  if (errors.length > 0) {
    console.error('ERRORES ENCONTRADOS:');
    errors.forEach(e => console.error(e));
    process.exit(1);
  }

  // Verificaciones de contenido esperado
  const doc = window.document;
  const assert = (cond, msg) => { if (!cond) { console.error('FALLÓ:', msg); process.exit(1); } };

  assert(doc.getElementById('heroScore').textContent === '+42', 'hero score debería mostrar +42');
  assert(doc.getElementById('heroLabel').textContent === 'Alcista con cautela', 'hero label incorrecto');
  assert(doc.getElementById('heroReason').textContent.includes('A favor'), 'la frase de razón debería mencionar "A favor"');
  assert(doc.getElementById('heroChips').children.length > 0, 'debería haber al menos un chip');
  assert(doc.getElementById('quickMetrics').children.length === 4, 'quickMetrics debería tener exactamente 4 tarjetas');
  assert(doc.getElementById('biasFactors').children.length === 10, 'deberían listarse los 10 factores en el detalle');
  assert(doc.getElementById('alertBox').style.display === 'block', 'la alerta debería estar visible');
  assert(doc.getElementById('detailSection').classList.contains('open') === false, 'el detalle debe arrancar CERRADO por defecto');
  assert(doc.getElementById('boxNote').textContent.includes('acumulando') || doc.getElementById('boxNote').textContent.includes('1 días'), 'la nota de la caja debería reflejar el estado de acumulación');

  console.log('OK: el render completo funciona sin errores con datos de ejemplo realistas.');
  console.log('Frase generada en el hero:', JSON.stringify(doc.getElementById('heroReason').textContent));
  process.exit(0); // el HTML real tiene setInterval (reloj, auto-refresh) que mantendría vivo el proceso
}

run();
