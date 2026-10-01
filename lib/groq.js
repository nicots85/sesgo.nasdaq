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


// Modelos en orden de preferencia. Groq da de baja modelos seguido (llama-3.3
// se retiró el 16/08/26): si uno falla por "modelo no existe", se prueba el siguiente.
const MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile'];
const ERROR_TTL_MS = 60 * 1000;
const TOTAL_BUDGET_MS = 9000; // Vercel corta las funciones cerca de los 10 s

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function buildBody(model, prompt, useJsonMode) {
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3
  };
  if (model.startsWith('openai/gpt-oss')) {
    // Modelos que "piensan": el razonamiento gasta tokens de la respuesta.
    // effort bajo + más espacio evita que el JSON llegue cortado.
    body.reasoning_effort = 'low';
    body.max_completion_tokens = 4000;
  } else {
    body.max_tokens = 2000;
  }
  if (useJsonMode) body.response_format = { type: 'json_object' };
  return body;
}

async function postOnce(model, prompt, useJsonMode, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBody(model, prompt, useJsonMode)),
      signal: ctrl.signal
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

async function callGroqWithFallback(prompt) {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const errors = [];

  for (const model of MODELS) {
    let useJsonMode = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = deadline - Date.now();
      if (left < 1500) throw new Error(`Sin tiempo restante. Errores: ${errors.join(' | ')}`);
      let r;
      try {
        r = await postOnce(model, prompt, useJsonMode, left);
      } catch (e) {
        errors.push(`${model}: ${e.name === 'AbortError' ? 'timeout' : e.message}`);
        break; // pasar al siguiente modelo
      }

      if (r.ok) {
        const data = JSON.parse(r.text);
        const choice = data.choices && data.choices[0];
        const content = choice && choice.message && choice.message.content;
        if (content && content.trim()) return { content, model };
        errors.push(`${model}: respuesta vacía (finish_reason=${choice && choice.finish_reason})`);
        break;
      }

      errors.push(`${model}: HTTP ${r.status} ${r.text.slice(0, 160)}`);
      if (r.status === 400 && /response_format|json/i.test(r.text) && useJsonMode) {
        useJsonMode = false; // ese modelo no acepta modo JSON: reintentar sin él
        continue;
      }
      if (r.status === 429 || r.status >= 500) {
        await sleep(800); // saturación temporal: un reintento con el mismo modelo
        continue;
      }
      break; // 400/401/403/404: no sirve reintentar igual → próximo modelo
    }
  }
  throw new Error(errors.join(' | ') || 'Groq no respondió');
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
    const { content, model } = await callGroqWithFallback(prompt);

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      const m = content.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
      else throw e;
    }
    const result = {
      overall_score: Math.max(-100, Math.min(100, Number(parsed.overall_score) || 0)),
      confidence: parsed.confidence || 'baja',
      individual: Array.isArray(parsed.individual) ? parsed.individual.slice(0, 10) : [],
      key_factor: parsed.key_factor || 'No determinado',
      alert: parsed.alert || null,
      model
    };
    cache = { key, data: result, ts: Date.now() };
    return result;
  } catch (e) {
    const result = { overall_score: 0, confidence: 'baja', individual: [], key_factor: 'Error Groq', alert: null, error: e.message };
    // Los errores se cachean solo 60 s (no 5 min): reintenta pronto sin martillar a Groq.
    cache = { key, data: result, ts: Date.now() - (CACHE_TTL_MS - ERROR_TTL_MS) };
    return result;
  }
}

module.exports = { analyzeNews, callGroqWithFallback, MODELS };
