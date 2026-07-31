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

  let analysis;
  if (allHeadlines.length === 0) {
    analysis = {
      overall_score: 0,
      confidence: 'baja',
      individual: [],
      key_factor: 'Sin noticias disponibles',
      alert: null
    };
  } else {
    analysis = await analyzeNews(allHeadlines);
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

module.exports = { fetchAndAnalyzeNews };
