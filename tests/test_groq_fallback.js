// Prueba lib/groq.js con respuestas SIMULADAS (no llama a Groq de verdad).
process.env.GROQ_API_KEY = 'test-key';
const assert = require('assert');
const groq = require('../lib/groq');

function mockFetch(sequence) {
  const calls = [];
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    const step = sequence.shift();
    return { ok: step.status === 200, status: step.status, text: async () => step.body };
  };
  return calls;
}
const good = (score) => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ overall_score: score }) } }] });

(async () => {
  // 1) Modelo principal responde bien
  let calls = mockFetch([{ status: 200, body: good(42) }]);
  let r = await groq.callGroqWithFallback('hola');
  assert.strictEqual(r.model, 'openai/gpt-oss-120b');
  assert.strictEqual(calls[0].reasoning_effort, 'low');
  assert.strictEqual(calls[0].max_completion_tokens, 4000);

  // 2) Modelo dado de baja (404) -> pasa al siguiente
  calls = mockFetch([
    { status: 404, body: '{"error":{"code":"model_not_found"}}' },
    { status: 200, body: good(10) }
  ]);
  r = await groq.callGroqWithFallback('hola');
  assert.strictEqual(r.model, 'openai/gpt-oss-20b');

  // 3) 429 -> reintenta el mismo modelo una vez
  calls = mockFetch([{ status: 429, body: 'rate' }, { status: 200, body: good(5) }]);
  r = await groq.callGroqWithFallback('hola');
  assert.strictEqual(r.model, 'openai/gpt-oss-120b');
  assert.strictEqual(calls.length, 2);

  // 4) El modelo no acepta response_format -> reintenta sin modo JSON
  calls = mockFetch([
    { status: 400, body: '{"error":"response_format json_object not supported"}' },
    { status: 200, body: good(7) }
  ]);
  r = await groq.callGroqWithFallback('hola');
  assert.ok(calls[0].response_format && !calls[1].response_format);

  // 5) Respuesta vacía (razonamiento se comió los tokens) -> siguiente modelo
  calls = mockFetch([
    { status: 200, body: JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '' } }] }) },
    { status: 200, body: good(3) }
  ]);
  r = await groq.callGroqWithFallback('hola');
  assert.strictEqual(r.model, 'openai/gpt-oss-20b');

  // 6) Todo falla -> error claro con el detalle
  calls = mockFetch([{ status: 401, body: 'bad key' }, { status: 401, body: 'bad key' }, { status: 401, body: 'bad key' }]);
  await assert.rejects(() => groq.callGroqWithFallback('hola'), /401/);

  // 7) analyzeNews de punta a punta
  mockFetch([{ status: 200, body: good(64) }]);
  const out = await groq.analyzeNews([{ source: 'X', title: 'noticia' }]);
  assert.strictEqual(out.overall_score, 64);
  console.log('OK test_groq_fallback: 7/7');
})().catch(e => { console.error('FALLO', e); process.exit(1); });
