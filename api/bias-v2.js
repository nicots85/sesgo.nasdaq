/**
 * Endpoint NUEVO y separado para la arquitectura experimental
 * "señal primaria + filtros" (FASE 4, PARTE B).
 *
 * NO reemplaza /api/bias ni el frontend actual — es un experimento que
 * convive aparte hasta que se decida promoverlo (requiere tracking hacia
 * adelante, Fase C). Ver research/bias-v2-experimental/README.md.
 */
const handler = require('./bias-v2-experimental').handler;

module.exports = handler;
