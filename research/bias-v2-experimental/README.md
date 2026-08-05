# bias-v2 — Arquitectura experimental "señal primaria + filtros"

> **ESTADO: EXPERIMENTAL.** No se usa para decisiones hasta validarla con
> tracking hacia adelante (Fase C). Convive en paralelo con `/api/bias`;
> no lo reemplaza.

## La idea

El score actual (`/api/bias`) **promedia** los 9 factores ponderados:
Caja overnight (peso 0.85, único con evidencia fuerte) vota junto con los
8 factores estructurales (peso combinado bajo, evidencia débil según la
Fase 2) como si todos tuvieran voto similar.

`bias-v2` cambia el modelo mental:

1. **Caja overnight** es la **SEÑAL PRIMARIA**. Es el único factor cuya
   evidencia está validada (Fase B original + test factor por factor:
   correlación y backtest de ruptura de `box-capture.js`). Define la
   **dirección** del sesgo (alcista si su score es > 0, bajista si es < 0).
2. El resto de los factores estructurales que **pasaron Bonferroni en la
   Fase 2** actúan como **FILTROS**. Un filtro solo puede:
   - **Confirmar** (su signo coincide con la señal → la confianza no cambia)
   - **Atenuar** (su signo contradice la señal → reduce la confianza)
   - **Nunca revertir** la dirección por sí solo.
3. Los factores que **NO pasaron Bonferroni** en la Fase 2 **no participan**
   (ya se sabe que no tienen edge; no deberían poder vetar la señal
   primaria).

## Fórmula

```
direccionBase = sign(scoreCaja)            // +1 alcista, -1 bajista, 0 sin señal
confianza     = 100 - (nº filtros en contra × PENALIDAD)   // clamp 0..100
scoreFinal    = direccionBase × |scoreCaja| × (confianza / 100)
```

`PENALIDAD_POR_FACTOR_EN_CONTRA = 15` puntos por factor en contra
(configurable en `api/bias-v2-experimental.js`).

## ¿Por qué es distinto del score actual?

| | /api/bias (V1) | /api/bias-v2 (experimental) |
|---|---|---|
| Modelo | Promedio ponderado de votos | Señal primaria + filtros |
| Rol de Caja overnight | Un voto más (peso alto) | La señal que manda |
| Factores estructurales | Votan igual (peso bajo) | Filtros que atenúan, no revierten |
| Factores sin Bonferroni | Aportan al promedio | Excluidos del todo |

## Estado de validación

- **Filtros activos hoy:** `['Nikkei']` — único factor que pasó Bonferroni
  (p=0.0009) en la Fase 2. Cuando una futura Fase valide más, se agregan.
- **Pendiente:** tracking hacia adelante (Fase C) para comparar
  `bias-v2` vs `bias` contra el retorno real del Nasdaq. Solo se promueve
  si la evidencia lo justifica.

## Endpoint

- `GET /api/bias-v2` → `{ biasV2: { direccionBase, confianza, scoreCaja, scoreFinal, etiqueta, desglose, parametros }, biasV1: {...}, timestamp }`
- No toca la ruta `/api/bias` ni el frontend.

## Tests

- `tests/test_bias_v2.js` — casos sintéticos: señal alcista con todos los
  filtros a favor (confianza 100, score intacto), 2 filtros en contra
  (cálculo exacto 100 − 2×15 = 70), factor sin Bonferroni que no veta,
  señal bajista, y filtro con dato faltante que no opina.
