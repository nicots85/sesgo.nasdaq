/**
 * PARTE B — Arquitectura alternativa "señal primaria + filtros"
 * (EXPERIMENTAL, convive en paralelo con /api/bias — no lo reemplaza)
 *
 * Diferencia central con el score actual:
 *   - /api/bias PROMEDIA los 9 factores (Caja overnight con ~0.85 de peso
 *     combinado con los 8 estructurales) como si todos "votaran igual".
 *   - bias-v2 usa Caja overnight (el ÚNICO factor con evidencia fuerte
 *     validada: Fase B + p=0.0009) como SEÑAL PRIMARIA. El resto de los
 *     factores estructurales que pasaron Bonferroni en la Fase 2 actúan
 *     como FILTROS: solo pueden CONFIRMAR (mantener confianza) o ATENUAR
 *     (reducir confianza) la señal — nunca revertirla por sí solos.
 *
 * Parámetros configurables:
 *   - FILTROS_ACTIVOS: factores estructurales que pasaron Bonferroni y,
 *     por lo tanto, tienen permitido tocar la confianza de la señal.
 *     Hoy SOLO Nikkei pasó (p=0.0009). Si una futura Fase valida más,
 *     se agregan acá.
 *   - PENALIDAD_POR_FACTOR_EN_CONTRA: puntos de confianza que resta cada
 *     filtro en contra (ajustable, documentado como parámetro).
 *
 * scoreFinal = direccionBase * |scoreCaja| * (confianza / 100)
 *
 * NO se usa para decisiones hasta validarlo con tracking hacia adelante
 * (Fase C). Ver research/bias-v2-experimental/README.md.
 */
const { getBias } = require('./bias');

// Factores estructurales que PASARON Bonferroni en la Fase 2 (388 días,
// 0.05/7 ≈ 0.0071). Solo Nikkei pasó → es el único filtro activo hoy.
const FILTROS_ACTIVOS = ['Nikkei'];

// Penalización por cada filtro en contra (puntos de confianza). Ajustable.
const PENALIDAD_POR_FACTOR_EN_CONTRA = 15;

/**
 * Lógica pura de bias-v2. Acepta el objeto bias completo (con .factors)
 * y opciones opcionales para tests / futuras configuraciones.
 */
function computeBiasV2(bias, { filtros = FILTROS_ACTIVOS, penalidad = PENALIDAD_POR_FACTOR_EN_CONTRA } = {}) {
  if (!bias || !Array.isArray(bias.factors)) {
    throw new Error('bias-v2: se requiere un objeto bias con .factors (array)');
  }

  const caja = bias.factors.find(f => f.name === 'Caja overnight');
  if (!caja) {
    throw new Error('bias-v2: no se encontró el factor "Caja overnight" en bias.factors');
  }
  if (caja.disponible === false || caja.score == null) {
    return {
      error: 'Caja overnight no disponible — sin señal primaria, bias-v2 no puede emitir dirección',
      direccionBase: 0,
      confianza: 0,
      scoreCaja: null,
      scoreFinal: 0,
      desglose: { nConfirmaron: 0, nContradijeron: 0, confirmaron: [], contradijeron: [] },
      parametros: { filtrosActivos: filtros, penalidadPorFactorEnContra: penalidad }
    };
  }

  // 1. Dirección base: signo de la Caja overnight
  const scoreCaja = caja.score;
  const direccionBase = scoreCaja > 0 ? 1 : scoreCaja < 0 ? -1 : 0;
  if (direccionBase === 0) {
    return {
      direccionBase: 0,
      confianza: 0,
      scoreCaja,
      scoreFinal: 0,
      etiqueta: 'NEUTRAL',
      desglose: { nConfirmaron: 0, nContradijeron: 0, confirmaron: [], contradijeron: [] },
      parametros: { filtrosActivos: filtros, penalidadPorFactorEnContra: penalidad }
    };
  }

  // 2. Confianza inicial: 100
  let confianza = 100;
  const confirmaron = [];
  const contradijeron = [];

  // 3. Cada filtro activo: coincide → confirma; contradice → reduce
  for (const f of bias.factors) {
    if (!filtros.includes(f.name)) continue; // no pasó Bonferroni → no filtra
    if (f.disponible === false || f.score == null || f.score === 0) continue; // sin dato o neutro → no opina

    const signoFactor = f.score > 0 ? 1 : f.score < 0 ? -1 : 0;
    if (signoFactor === direccionBase) {
      confirmaron.push(f.name);
    } else {
      contradijeron.push(f.name);
      confianza -= penalidad;
    }
  }

  confianza = Math.max(0, Math.min(100, confianza)); // no puede salir de 0..100

  // 4. scoreFinal = direccionBase * |scoreCaja| * (confianza/100)
  const scoreFinal = direccionBase * Math.abs(scoreCaja) * (confianza / 100);

  const etiqueta = scoreFinal > 0 ? (scoreFinal >= 14 ? 'ALCISTA CON CAUTELA' : 'ALCISTA SUAVE')
    : scoreFinal < 0 ? (scoreFinal <= -14 ? 'BAJISTA CON CAUTELA' : 'BAJISTA SUAVE')
      : 'NEUTRAL';

  return {
    direccionBase,
    confianza,
    scoreCaja,
    scoreFinal: Math.round(scoreFinal * 100) / 100,
    etiqueta,
    desglose: {
      nConfirmaron: confirmaron.length,
      nContradijeron: contradijeron.length,
      confirmaron,
      contradijeron
    },
    parametros: { filtrosActivos: filtros, penalidadPorFactorEnContra: penalidad }
  };
}

async function getBiasV2() {
  const result = await getBias();
  return {
    biasV2: computeBiasV2(result.bias),
    // Contexto del score V1 para comparar (no se mezclan en el cálculo)
    biasV1: { score: result.bias.score, label: result.bias.label, factoresExcluidosPorDatoFaltante: result.bias.factoresExcluidosPorDatoFaltante },
    timestamp: new Date().toISOString()
  };
}

async function handler(req, res) {
  try {
    res.setHeader('Content-Type', 'application/json');
    const result = await getBiasV2();
    res.writeHead(200);
    res.end(JSON.stringify(result));
  } catch (error) {
    console.error('/api/bias-v2 error:', error.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

module.exports = handler;
module.exports.handler = handler;
module.exports.getBiasV2 = getBiasV2;
module.exports.computeBiasV2 = computeBiasV2;
module.exports.FILTROS_ACTIVOS = FILTROS_ACTIVOS;
module.exports.PENALIDAD_POR_FACTOR_EN_CONTRA = PENALIDAD_POR_FACTOR_EN_CONTRA;
