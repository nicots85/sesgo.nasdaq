# Resultados — Fase 2: Test de significancia factor por factor

**Fecha:** 2026-08-04
**Motor:** `research/phase-b-structural-backtest/run-phase-b-per-factor.js`
**Datos:** Yahoo Finance, 2 años → 390 fechas alineadas → **388 días utilizables**
**Regla de lag anti-look-ahead:** idéntica a `run-phase-b.js` (Nikkei/KOSPI
mismo día D; VIX/DXY/WTI nivel de D-1; USD/JPY/S&P 500 cambio de D-1;
Nasdaq momentum lag-1 = cambio de D-1).
**Scores:** importados de `api/bias.js` (`scoreVix`, `scoreDxy`, ...) — las
mismas reglas puras que usa producción.
**Corrección por comparaciones múltiples:** Bonferroni `0.05/7 ≈ 0.0071`
para los 7 estructurales. El candidato "Nasdaq momentum (lag 1)" es una
octava prueba → umbral `0.05/8 ≈ 0.00625`.

## Tabla de resultados (ordenada de mayor a menor evidencia)

| # | Factor | raw | r | p crudo | Bonferroni | ¿pasa? | Acierto dir. | N |
|---|--------|-----|---|---------|------------|--------|--------------|---|
| 1 | **Nikkei** | change-D (pre-market) | **+0.168** | **0.0009** | 0.0071 | **SÍ** | **57.7%** | 388 |
| 2 | KOSPI | change-D (pre-market) | +0.125 | 0.0136 | 0.0071 | no | 57.5% | 388 |
| 3 | VIX | level-D1 | −0.110 | 0.0298 | 0.0071 | no | 50.3% | 388 |
| 4 | DXY (Dólar) | level-D1 | +0.069 | 0.1734 | 0.0071 | no | 53.9% | 388 |
| 5 | USD/JPY | change-D1 | −0.058 | 0.2533 | 0.0071 | no | 45.6% | 193 |
| 6 | Crudo (WTI) | level-D1 | −0.021 | 0.6864 | 0.0071 | no | 52.6% | 388 |
| 7 | S&P 500 | change-D1 | −0.004 | 0.9412 | 0.0071 | no | 53.8% | 277 |
| 8 | Nasdaq momentum (lag 1) [candidato] | change-D1 | −0.002 | 0.9679 | 0.00625 | no | 52.1% | 330 |

## Interpretación honesta

- **Solo un factor pasa la corrección de Bonferroni: Nikkei** (p=0.0009,
  r=+0.168, 57.7% de acierto direccional con p≈0.002). Es la única señal
  estructural con evidencia robusta de los 7 testeados. Es coherente con la
  tesis del proyecto: el pre-market de Asia-Pacífico (Nikkei) es la mejor
  señal anticipatoria del Nasdaq.
- **KOSPI no pasa** (p=0.0136), aunque su acierto direccional (57.5%) es
  parecido al de Nikkei. Queda por debajo del umbral corregido; no se lo
  puede declarar significativo sin más evidencia.
- **VIX no pasa** (p=0.0298): la correlación de niveles con D-1 es marginal.
  Su acierto direccional (50.3%) no aporta señal direccional.
- **DXY, USD/JPY, WTI y S&P 500 claramente no tienen edge** (p > 0.17 en
  todos). Son ruido en esta muestra y con estas reglas.
- **El candidato "Nasdaq momentum (lag 1)" NO tiene edge** (p=0.9679,
  52.1% de acierto, p=0.44). Esto confirma empíricamente la decisión de la
  Fase 1.5 de no ponderar el momentum: la versión no circular tampoco
  predice. **No se reincorpora al score.**
- **Advertencia metodológica:** los p-values son de un test sobre datos
  reales (no una garantía a futuro). El control negativo (ruido puro, 20
  corridas) muestra una tasa de falsos positivos por factor de ~5% como se
  espera, así que la prueba no está sesgada sistemáticamente. Aun así, 388
  días es una muestra acotada: estos resultados son la mejor evidencia
  disponible hoy, no una ley.

## Consecuencia operativa (re-ponderación automática aplicada)

Regla objetiva (sin criterio discrecional):
- **Pasa Bonferroni** → mantiene su peso. → **Nikkei** (0.06, condicional a
  cointegración).
- **No pasa Bonferroni** → baja al piso mínimo **0.01**. → KOSPI, VIX, DXY,
  USD/JPY, WTI, S&P 500.
- Peso liberado total: VIX 0.09 + DXY 0.07 + USD/JPY 0.07 + KOSPI 0.04 +
  S&P 0.05 + WTI 0.03 = **0.35** → se reasigna **completo a Caja
  overnight** (0.50 → **0.85**), el único factor con evidencia validada.
- Noticias (IA): no testable retroactivamente (sin historial), mantiene 0.13.

Implementado en `api/bias.js` (ver comentario sobre el array `factors`).
