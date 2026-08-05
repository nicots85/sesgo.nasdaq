# Metodología del "Sesgo del día" — Nasdaq (USTEC)

## 0. Aclaración de terminología (por qué "sesgo" y no otra cosa)

Esta página usa **"sesgo"** en el sentido de *bias* — inclinación o
tendencia direccional del sentimiento de mercado. **No** es el
coeficiente de asimetría estadística (*skewness*, que mide la forma de
una distribución de probabilidad). Es un índice compuesto de
sentimiento/dirección, no una medida de forma distribucional. Cualquier
lectura que compare este número con un cálculo de skewness parte de una
confusión de términos, no de un error del índice en sí.

## 1. Qué es exactamente el score

Un índice compuesto de 0 a ±100, construido a partir de **9 factores**
de mercado, cada uno con:

- **raw**: el dato de mercado tal cual (precio, % de cambio, etc.)
- **score**: ese dato convertido a una escala de -100 (muy bajista) a
  +100 (muy alcista), según reglas de umbral definidas por criterio
  experto
- **weight**: cuánto pesa ese factor en el resultado final

## 2. La fórmula exacta

```
score_final = Σ (factor.score × factor.weight) / Σ (factor.weight)
```

**Importante:** el denominador es la suma REAL de los pesos activos ese
día, no siempre 1.0. Esto importa por dos razones:

1. Dos de los nueve factores (Nikkei y KOSPI) tienen **peso variable**:
   ver sección 4.
2. **Datos faltantes (Fase 4):** si un factor no tiene dato válido ese
   día, se **excluye del numerador Y del denominador** (no se fuerza a
   score 0 con peso completo, que enfriaba el score hacia neutral de
   forma artificial). Ver sección 7b.

El resultado se redondea al entero más cercano.

## 3. Los 9 factores, en detalle

> **PESOS VIGENTES (desde Fase 2, agosto 2026):** los pesos de la tabla
> fueron re-ponderados automáticamente con el resultado del test factor
> por factor (ver sección 10 y `research/.../RESULTADOS_POR_FACTOR.md`).
> Solo **Nikkei** pasó la corrección de Bonferroni (p=0.0009). Todos los
> demás estructurales bajaron al piso 0.01, y el peso liberado (0.35) se
> reasignó completo a Caja overnight (0.85).

| # | Factor | Qué mide (`raw`) | Peso | Cómo se calcula el score |
|---|--------|-------------------|------|---------------------------|
| 1 | Caja overnight | % de veces que una ruptura alcista del rango overnight continuó (backtest propio, ver `box-capture.js`) | **0.85** | `scoreCaja`: `(pctContinuación - 50) × 2` — 50% = score 0 (neutro), 100% = score 100 |
| 2 | VIX | Nivel del índice VIX | 0.01 | `scoreVix`: <15→+80, <17→+50, <20→+10, <25→-50, ≥25→-80 |
| 3 | DXY (Dólar) | Nivel del índice dólar (proxy) | 0.01 | `scoreDxy`: <99→+60, <102→+10, <104→-30, ≥104→-60 |
| 4 | USD/JPY | % de cambio del día | 0.01 | `scoreUsdjpy`: >1%→+50, >0.3%→+20, <-1.5%→-80, <-0.5%→-40, resto→0 |
| 5 | Nikkei | % de cambio del día | **0.06 o 0.01** (ver sección 5) | `scoreNikkei(chg, coint)`: solo si cointegrado: >1%→+60, >0%→+30, <-1%→-60, <0%→-30. Si no cointegrado: **0** |
| 6 | KOSPI | % de cambio del día | 0.01 | `scoreKospi(chg, coint)`: misma lógica que Nikkei |
| 7 | S&P 500 | % de cambio del día | 0.01 | `scoreSp500`: >1%→+50, >0.3%→+20, <-1%→-50, <-0.3%→-20, resto→0 |
| 8 | Crudo (WTI) | Precio en USD | 0.01 | `scoreWti`: >100→-50, >85→-20, >70→-10, ≥60→+15, <60→+40 |
| 9 | Noticias (IA) | Score de sentimiento (-100 a +100) de Groq/Llama 3.3 sobre RSS + NewsAPI | 0.13 | `scoreNoticias`: se usa directo, acotado a [-100, 100] |

> **Regla de re-ponderación (Fase 2):** cada regla de scoring vive como
> función pura exportada en `api/bias.js` (`scoreVix`, `scoreDxy`, ...) y
> se reutiliza en el backtest — no hay dos versiones de ninguna regla. Los
> pesos se reasignan por evidencia: si el test factor por factor (Bonferroni
> 0.05/7) muestra que un factor no tiene edge, su peso baja al piso 0.01 y el
> peso liberado va completo a Caja overnight.

> **¿Por qué ya no hay "Fear & Greed"?** Hasta la Fase 1, el índice
> ponderaba "VIX" (peso 0.10) y "Fear & Greed" (peso 0.05) como dos
> señales independientes. Pero en `api/market.js`, `fetchFearGreed()`
> calcula el valor de Fear & Greed **a partir del propio VIX** (buckets
> fijos sobre el precio del VIX), no desde un dato independiente. Eran la
> misma información contada dos veces, con 0.15 de peso combinado. Se
> eliminó el factor del cálculo ponderado, y los 0.05 liberados se
> reasignaron a "Caja overnight" (0.40). El dato de Fear & Greed **sigue
> devolviéndose** en la respuesta de la API dentro de `market.fearGreed`
> — solo como información, sin ponderar en el score.

> **¿Por qué ya no hay "Momentum Nasdaq"?** En una sesión previa se
> agregó un factor "Momentum Nasdaq" (peso 0.10) que usaba la variación
> del día del propio ^NDX (incluye pre-market/sesión en curso) para
> alimentar el score. Eso es **circular**: el score describe el
> movimiento del Nasdaq y al mismo tiempo usaba el movimiento del Nasdaq
> como insumo, contaminando la señal con el propio activo que se intenta
> predecir. Se eliminó del cálculo ponderado (Fase 1.5) con el mismo
> tratamiento que "Fear & Greed", y los 0.10 liberados se reasignaron a
> "Caja overnight" (0.40 → **0.50**). Existe una versión **NO circular**
> en investigación: el momentum del día ANTERIOR (variación de D-1 vs
> D-2, con lag de 1 día), que se prueba como candidato en la Fase 2
> extendida (test factor por factor) antes de decidir si se reincorpora
> al score con peso.

## 4. Datos informativos (no ponderados)

Hay datos que la API devuelve pero que **no participan del cálculo del
score** a propósito. El frontend los muestra como "estado actual":

- **`market.nasdaqLive`** — precio y variación del día del ^NDX en
  tiempo real (ej. `{ price: 25122.18, change: 2.78 }`). No pondera por
  **circularidad**: es el mismo activo que el score describe, usarlo
  como insumo sería predecir el Nasdaq con el Nasdaq. Se mantiene como
  información de contexto.
- **`market.fearGreed`** — proxy 0-100 derivado del VIX. No pondera por
  **redundancia**: ya está contado dentro del factor VIX (ver sección 3).
- **`market.nasdaq`** — el objeto completo del ^NDX (se conserva para
  compatibilidad con el frontend; la variación "oficial" informativa es
  `market.nasdaqLive`).

## 5. El caso especial de Nikkei y KOSPI

**Nikkei** es el único estructural que pasó la re-ponderación de la Fase 2
(p=0.0009), así que conserva peso **condicional a cointegración**
(Engle-Granger, ver `lib/stats.js`), calculada ese mismo día:

- **Si está cointegrado** (`isCointegrated: true`): peso **0.06** y su
  score refleja su movimiento del día.
- **Si NO está cointegrado**: peso baja a 0.01 y su score se fuerza a 0.

**KOSPI NO pasó la Fase 2** (p=0.0136, umbral 0.0071): su peso es fijo en
el piso **0.01** (el score sigue con la misma lógica de umbrales, pero su
influencia en el score final es mínima). Ya no "cambia de peso" según
cointegración.

**Por qué importa esto:** el informe de auditoría externa asumió pesos
fijos de 0.06/0.05 para ambos porque el día que lo generaron estaban
cointegrados. Otro día, con cointegración distinta, solo el peso de Nikkei
cambia — esto es esperado, no un error.

## 6. Los pesos se derivan de la evidencia (Fase 2)

Antes de la Fase 2, los 9 pesos eran asignados por criterio propio (0.50,
0.10, 0.08...). Desde la Fase 2, la re-ponderación es **automática y
objetiva**: cada factor estructural se testeó aislado contra el retorno del
Nasdaq (388 días, Bonferroni 0.05/7 ≈ 0.0071) y el peso se ajustó según el
resultado:

- Pasa Bonferroni → mantiene su peso (solo Nikkei, p=0.0009 → 0.06).
- No pasa → baja al piso 0.01 (KOSPI, VIX, DXY, USD/JPY, WTI, S&P 500).
- El peso liberado (0.35) se reasigna **completo** a Caja overnight
  (0.50 → **0.85**), el único factor con evidencia fuerte ya validada en la
  Fase B original.

El score sigue siendo **una síntesis organizada de evidencia**, no un
modelo predictivo validado a futuro: el test factor por factor (ver
`research/.../RESULTADOS_POR_FACTOR.md`) es la mejor evidencia disponible
sobre 388 días, no una garantía.

## 7. Umbrales de la etiqueta final

Los umbrales se **calibran contra la distribución real del score**, no a
ojo. El cálculo se hace con `research/.../compute-score-distribution.js`:
reconstruye el score completo día por día (388 días, 2 años de Yahoo),
con los pesos actualizados de la Fase 2 y las mismas reglas de lag de la
Fase B (Noticias = 0, Caja = valor de referencia fijo).

Serie calculada el **2026-08-04**: min=5 | max=16 | media=10.96 |
desvío=3.09. Percentiles: p10=7, p25=8, p30=9, p40=10, p50=11, p60=13,
p70=13, p75=14, p90=15.

Regla objetiva de mapeo (NEUTRAL = 40% central real de los datos):

| Score | Etiqueta |
|-------|----------|
| > 15 (score > p90) | ALCISTA FUERTE |
| 14 a 15 (p70 < score ≤ p90) | ALCISTA CON CAUTELA |
| 10 a 13 (p30 < score ≤ p70) | NEUTRAL |
| 8 a 9 (p10 < score ≤ p30) | BAJISTA CON CAUTELA |
| ≤ 7 (score ≤ p10) | BAJISTA FUERTE |

> **Cuándo recalibrar:** los valores numéricos quedaron fijos en
> `api/bias.js` (constante `THRESHOLDS`) y no se recalculan en cada
> request. Se recalibran **manualmente** cuando cambien materialmente los
> pesos de los factores (una nueva Fase de re-ponderación) o cada unos
> meses de datos nuevos acumulados. La fecha de cálculo está anotada para
> saber cuándo volver a correr el script.

## 7b. Datos faltantes (Fase 4)

Cuando un factor no tiene dato válido ese día, se **excluye por completo**
del cálculo: no entra ni en el numerador ni en el denominador. No se lo
fuerza a score 0 con su weight completo, porque eso "enfriaba" el score
hacia neutral de forma artificial (el mercado no estaba neutral; faltaba
el dato).

Cuándo un factor cuenta como no disponible:

- **Noticias (IA)**: si `analysis.error` existe (Groq con rate limit,
  timeout, API key caída, fallo de conexión).
- **KOSPI**: si `market.kospi._invalid === true` (dato corrupto de Yahoo,
  valor de emergencia).
- **Cualquier otro**: si su dato crudo (`raw`) es `null`/`undefined`
  (ej. `market.vix == null`).
- **Caja overnight** siempre está disponible: si el backtest dinámico de
  `box-capture.js` no tiene datos suficientes, se usa el valor de
  referencia fijo (nunca es "dato faltante").

Cada factor lleva la bandera `disponible: true/false` en `bias.factors`, y
el resultado incluye `factoresExcluidosPorDatoFaltante` (array de nombres)
para que el frontend muestre "hoy faltó Noticias por límite de Groq" en
vez de que parezca un mercado neutral.

## 8. Limitaciones conocidas (activas al momento de escribir esto)

- **Caja overnight (peso 0.85, el factor más pesado)**: hasta que se
  acumulen 30 días hábiles de historial real vía `box-capture.js`, usa
  un valor de referencia fijo de un backtest manual de 515 días
  (56.7% de continuación). Se actualiza solo una vez alcanzado ese
  mínimo — ver `api/box-capture.js`.
- **El "Nasdaq ahora" no pondera** (ver secciones 3 y 4): la variación
  del día del propio ^NDX (`market.nasdaqLive`) es información circular
  para un score que describe el ^NDX, así que se muestra como contexto
  pero no entra en el número. Se está probando la versión con lag de 1
  día (momentum de ayer) en la Fase 2 para ver si tiene edge real sin
  circularidad.
- **El proxy de Fear & Greed ya no pondera** (ver nota en sección 3): se
  sigue calculando y devolviendo en `market.fearGreed` como dato
  informativo, pero no es el índice oficial de CNN (es un proxy del VIX,
  porque CNN bloquea el acceso automatizado) y desde la Fase 1 quedó
  fuera del cálculo del score para evitar doble conteo con el factor VIX.
- **KOSPI**: la fuente (Yahoo Finance) devuelve ocasionalmente un dato
  corrupto; el código cae a un valor fijo de emergencia
  (`_invalid: true`) cuando esto pasa. Desde la **Fase 4**, cuando eso
  ocurre el factor se excluye por completo del score (ver sección 7b) en
  vez de enfriar el resultado con un dato falso.
- **Sin intervalos de confianza ni bandas de error** en el score final
  — es un número puntual, no una estimación con incertidumbre
  cuantificada.
- **El factor "Noticias (IA)" no tiene historial reconstruible** — no
  hay archivo de qué noticia exacta salió cada día pasado, así que no
  puede formar parte de ningún backtest retroactivo (solo del tracking
  hacia adelante, ver Fase C).

## 9. Qué sigue (hoja de ruta de validación)

1. ✅ **Fase A (este documento)**: transparencia total de la
   metodología actual.
2. ✅ **Fase B**: backtest retroactivo del sub-score estructural contra
   movimientos reales del Nasdaq (388 días). Incluye la **Fase 2**: test
   factor por factor (7 estructurales + el candidato "Nasdaq momentum
   lag-1") → solo Nikkei pasa Bonferroni; el resto bajó a piso 0.01 y el
   peso liberado fue a Caja overnight. Resultados completos en
   `research/.../RESULTADOS_POR_FACTOR.md`.
3. ⏳ **Fase C**: desde ahora, guardar el score completo (los 9
   factores, con noticias incluidas) todos los días, para construir un
   track record real de la fórmula completa a lo largo del tiempo.
