require('dotenv').config();
const GROQ_KEY = process.env.GROQ_API_KEY;

async function analyzeNews(headlines) {
  if (!GROQ_KEY) {
    return {
      overall_score: 0,
      confidence: 'baja',
      individual: [],
      key_factor: 'API key no configurada',
      alert: null,
      error: 'GROQ_API_KEY no set'
    };
  }

  const prompt = `Eres un analista financiero experto del mercado de Norteamérica. Analiza estas noticias y asigna un puntaje de -100 (extremadamente bajista para Nasdaq) a +100 (extremadamente alcista).

Noticias:
${headlines.map((h, i) => `${i + 1}. [${h.source}] ${h.title}`).join('\n')}

Responde SOLO en JSON válido con esta estructura exacta:
{
  "overall_score": número entre -100 y 100,
  "confidence": "alta" o "media" o "baja",
  "individual": [
    {"title": "título corto", "score": número, "reason": "razón en español"}
  ],
  "key_factor": "factor más importante para Nasdaq",
  "alert": null o "texto de alerta si algo es crítico"
}`;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 1000,
        response_format: { type: 'json_object' }
      }),
      signal: ctrl.signal
    });
    clearTimeout(timer);

    if (!res.ok) {
      const err = await res.text();
      return { overall_score: 0, confidence: 'baja', individual: [], key_factor: 'Error Groq', alert: null, error: err };
    }

    const data = await res.json();
    const content = data.choices[0].message.content;
    const parsed = JSON.parse(content);

    return {
      overall_score: Math.max(-100, Math.min(100, Number(parsed.overall_score) || 0)),
      confidence: parsed.confidence || 'baja',
      individual: Array.isArray(parsed.individual) ? parsed.individual.slice(0, 10) : [],
      key_factor: parsed.key_factor || 'No determinado',
      alert: parsed.alert || null
    };
  } catch (e) {
    return { overall_score: 0, confidence: 'baja', individual: [], key_factor: 'Error de conexión', alert: null, error: e.message };
  }
}

module.exports = { analyzeNews };
