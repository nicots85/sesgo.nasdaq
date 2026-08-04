require('dotenv').config();
const GROQ_KEY = process.env.GROQ_API_KEY;

// Caché simple en memoria: evita llamar a Groq en cada request del panel.
// La clave es la firma de las headlines (si cambian las noticias, cambia la clave).
// TTL de 5 min: máximo 1 análisis cada 5 min por contenido distinto, en vez de
// ~1 cada 45s (que agota el rate limit de Groq y causa errores 429/500).
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = { key: null, data: null, ts: 0 };

function headlinesKey(headlines) {
  return (headlines || []).slice(0, 30).map(h => `${h.source}|${h.title}`).join('§');
}

async function analyzeNews(headlines) {
  // Cache hit: mismo contenido y dentro del TTL
  const key = headlinesKey(headlines);
  const now = Date.now();
  if (cache.key === key && cache.data && now - cache.ts < CACHE_TTL_MS) {
    return cache.data;
  }

  if (!GROQ_KEY) {
    const fallback = {
      overall_score: 0,
      confidence: 'baja',
      individual: [],
      key_factor: 'API key no configurada',
      alert: null,
      error: 'GROQ_API_KEY no set'
    };
    cache = { key, data: fallback, ts: now };
    return fallback;
  }

  const prompt = `Eres un analista financiero experto del mercado de Norteamérica (Nasdaq-100). Las noticias GEOPOLÍTICAS (guerras, sanciones, aranceles, elecciones, política de la Fed, tensiones comerciales) son DETERMINANTES para el mercado y deben pesar más que las noticias corporativas rutinarias. Analiza estas noticias y asigna un puntaje de -100 (extremadamente bajista para Nasdaq) a +100 (extremadamente alcista).

Noticias:
${headlines.map((h, i) => `${i + 1}. [${h.source}] ${h.title}`).join('\n')}

Responde SOLO en JSON válido con esta estructura exacta:
{
  "overall_score": número entre -100 y 100,
  "confidence": "alta" o "media" o "baja",
  "individual": [
    {"title": "título corto", "score": número, "reason": "razón en español"}
  ],
  "key_factor": "factor más importante para Nasdaq (priorizar lo geopolítico)",
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

    let result;
    if (!res.ok) {
      const err = await res.text();
      result = { overall_score: 0, confidence: 'baja', individual: [], key_factor: 'Error Groq', alert: null, error: err };
    } else {
      const data = await res.json();
      const content = data.choices[0].message.content;
      const parsed = JSON.parse(content);
      result = {
        overall_score: Math.max(-100, Math.min(100, Number(parsed.overall_score) || 0)),
        confidence: parsed.confidence || 'baja',
        individual: Array.isArray(parsed.individual) ? parsed.individual.slice(0, 10) : [],
        key_factor: parsed.key_factor || 'No determinado',
        alert: parsed.alert || null
      };
    }
    // Guardar en caché (incluso errores, para no martillar a Groq cuando falla)
    cache = { key, data: result, ts: Date.now() };
    return result;
  } catch (e) {
    const result = { overall_score: 0, confidence: 'baja', individual: [], key_factor: 'Error de conexión', alert: null, error: e.message };
    // No cachear errores de conexión para poder reintentar en la próxima consulta
    return result;
  }
}

module.exports = { analyzeNews };
