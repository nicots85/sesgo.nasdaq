require('dotenv').config();

let kv;
try {
  kv = require('@vercel/kv').kv;
} catch (e) {
  kv = null;
}

const { SYMBOLS, fetchHistorical } = require('./market');
const { loadHistoricalPrices, saveHistoricalPrices } = require('./bias');

module.exports = async function handler(req, res) {
  const day = new Date().getUTCDay();
  if (day === 0 || day === 6) {
    return res.json({ skipped: 'weekend', date: new Date().toISOString() });
  }

  const results = { updated: [], errors: [] };

  try {
    const historicalPrices = await loadHistoricalPrices();

    for (const [name, symbol] of Object.entries(SYMBOLS)) {
      try {
        const data = await fetchHistorical(symbol, 252);
        if (data.length > 0) {
          const closes = data.map(d => d.close);
          const existing = historicalPrices[name] || [];
          const combined = [...existing, ...closes];
          historicalPrices[name] = combined.slice(-300);
          results.updated.push(name);
        }
      } catch (e) {
        results.errors.push(`${name}: ${e.message}`);
      }
    }

    await saveHistoricalPrices(historicalPrices);

    if (kv) {
      const today = new Date().toISOString().split('T')[0];
      const monthKey = today.slice(0, 7);

      try {
        const { getBias } = require('./bias');
        const result = await getBias();

        await kv.set(`bias:${today}`, {
          score: result.bias.score,
          label: result.bias.label,
          timestamp: new Date().toISOString()
        });

        const history = (await kv.get(`bias_history:${monthKey}`)) || [];
        if (!history.find(h => h.date === today)) {
          history.push({ date: today, score: result.bias.score, label: result.bias.label });
          await kv.set(`bias_history:${monthKey}`, history);
        }

        results.biasSaved = true;
      } catch (e) {
        results.errors.push(`KV bias: ${e.message}`);
      }

      const currentMonth = today.slice(0, 7);
      const lastMonth = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 7);
      if (currentMonth !== lastMonth) {
        try {
          await kv.del(`bias_history:${lastMonth}`);
          results.cleanedMonth = lastMonth;
        } catch (e) { }
      }
    }

    res.json({ success: true, ...results });

  } catch (error) {
    res.status(500).json({ error: error.message, ...results });
  }
};
