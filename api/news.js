const { analyzeNews } = require('../lib/groq');
const { fetchRSS } = require('../lib/rss');

const NEWS_API_KEY = process.env.NEWS_API_KEY;

async function fetchENNews() {
  if (!NEWS_API_KEY) return [];
  try {
    const res = await fetch(
      `https://newsapi.org/v2/top-headlines?country=us&category=business&pageSize=15&apiKey=${NEWS_API_KEY}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.articles || []).map(a => ({
      title: a.title || '',
      source: a.source?.name || 'Unknown',
      url: a.url || '',
      language: 'en'
    }));
  } catch (e) {
    console.error('NewsAPI error:', e.message);
    return [];
  }
}

async function fetchAndAnalyzeNews() {
  const rssNews = await fetchRSS();
  const enNews = rssNews.filter(h => h.lang === 'en');
  const esNews = rssNews.filter(h => h.lang === 'es');
  const newsapiNews = await fetchENNews();

  const allHeadlines = [...enNews, ...esNews, ...newsapiNews].filter(h => h.title);

  // Priorizar geopolítica (determinante): mover las fuentes geopolíticas al frente
  const GEO = ['BBC', 'Al Jazeera', 'Guardian', 'Reuters', 'Bloomberg', 'France24', 'CNBC Politics', 'RT'];
  const geo = allHeadlines.filter(h => GEO.some(g => h.source.includes(g)));
  const rest = allHeadlines.filter(h => !GEO.some(g => h.source.includes(g)));
  const ordered = [...geo, ...rest];

  // Límite de headlines para el análisis Groq (evita saturar el contexto)
  const forAnalysis = ordered.slice(0, 30);

  let analysis;
  if (forAnalysis.length === 0) {
    analysis = {
      overall_score: 0,
      confidence: 'baja',
      individual: [],
      key_factor: 'Sin noticias disponibles',
      alert: null
    };
  } else {
    analysis = await analyzeNews(forAnalysis);
  }

  return {
    analysis,
    sources: {
      english: enNews.length + newsapiNews.length,
      spanish: esNews.length,
      total: allHeadlines.length
    },
    headlines: allHeadlines.slice(0, 20)
  };
}

// Handler HTTP para Vercel (/api/news) y server.js local.
// Devuelve noticias + análisis IA, ordenadas por impacto para trading.
async function handler(req, res) {
  try {
    const result = await fetchAndAnalyzeNews();
    // Ordenar por impacto: |score| más grande primero (las que más mueven NQ)
    const individual = [...(result.analysis.individual || [])]
      .sort((a, b) => Math.abs(b.score || 0) - Math.abs(a.score || 0))
      .slice(0, 6);
    const body = JSON.stringify({ ...result, analysis: { ...result.analysis, individual }, timestamp: new Date().toISOString() });
    if (res) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.writeHead(200);
      res.end(body);
      return;
    }
    return body;
  } catch (e) {
    console.error('/api/news error:', e.message);
    if (res) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
    return JSON.stringify({ error: e.message });
  }
}

module.exports = handler;
module.exports.fetchAndAnalyzeNews = fetchAndAnalyzeNews;
module.exports.handler = handler;
