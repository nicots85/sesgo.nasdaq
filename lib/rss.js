let Parser;
try {
  Parser = require('rss-parser');
} catch (e) {
  Parser = null;
}

const FEEDS = [
  // Español
  { name: 'Infobae Argentina', url: 'https://www.infobae.com/arc/outboundfeeds/rss/argentina/', lang: 'es' },
  { name: 'El Cronista', url: 'https://www.cronista.com/files/rss/news.xml', lang: 'es' },
  { name: 'La Nación', url: 'https://www.lanacion.com.ar/arc/outboundfeeds/rss/?outputType=xml', lang: 'es' },
  { name: 'Perfil', url: 'https://www.perfil.com/feed', lang: 'es' },
  // Español — geopolítica (determinante para el sesgo)
  { name: 'BBC Mundo', url: 'https://feeds.bbci.co.uk/mundo/rss.xml', lang: 'es' },
  { name: 'France24 Español', url: 'https://www.france24.com/es/rss', lang: 'es' },

  // Inglés - sin API key
  { name: 'MarketWatch', url: 'https://feeds.marketwatch.com/marketwatch/topstories/', lang: 'en' },
  { name: 'CNBC Markets', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', lang: 'en' },
  { name: 'Yahoo Finance', url: 'https://finance.yahoo.com/news/rssindex', lang: 'en' },
  { name: 'Investing.com', url: 'https://www.investing.com/rss/news_25.rss', lang: 'en' },
  // Inglés — geopolítica (determinante para el sesgo)
  { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', lang: 'en' },
  { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', lang: 'en' },
  { name: 'The Guardian World', url: 'https://www.theguardian.com/world/rss', lang: 'en' },
  { name: 'Reuters World', url: 'https://feeds.feedburner.com/ReutersWorldNews', lang: 'en' },
  { name: 'CNBC Politics', url: 'https://www.cnbc.com/id/10000113/device/rss/rss.html', lang: 'en' },
  { name: 'Bloomberg Markets', url: 'https://feeds.bloomberg.com/markets/news.rss', lang: 'en' }
];

async function fetchRSS() {
  if (!Parser) {
    return [];
  }

  const parser = new Parser({
    timeout: 8000,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });

  const articles = [];

  const fetches = FEEDS.map(async (feed) => {
    try {
      const result = await parser.parseURL(feed.url);
      const items = (result.items || []).slice(0, 3).map(item => ({
        title: item.title || '',
        link: item.link || '',
        source: feed.name,
        lang: feed.lang,
        pubDate: item.pubDate || item.isoDate || '',
        snippet: (item.contentSnippet || item.content || '').substring(0, 200)
      }));
      articles.push(...items);
    } catch (e) {
      console.error(`RSS error [${feed.name}]:`, e.message);
    }
  });

  await Promise.allSettled(fetches);
  return articles;
}

module.exports = { fetchRSS };
