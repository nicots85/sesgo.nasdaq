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
> reasigna a Caja overnight de forma **condicional al modo** (Fase 5): en
> modo dinámico Caja queda en 0.85; en modo fallback (valor de referencia
> fijo) se reparte 50/50 con Nikkei → Caja 0.675 / Nikkei 0.235 (ver
> sección 6b).

| # | Factor | Qué mide (`raw`) | Peso | Cómo se calcula el score |
|---|--------|-------------------|------|---------------------------|
| 1 | Caja overnight | % de veces que una ruptura alcista del rango overnight continuó (backtest propio, ver `box-capture.js`) | **0.675/0.85** (condicional al modo, ver 6b) | `scoreCaja`: `(pctContinuación - 50) × 2` — 50% = score 0 (neutro), 100% = score 100 |
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
> peso liberado va a Caja overnight (condicional al modo, Fase 5, ver 6b).

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
- El peso liberado (0.35) se reasigna de forma **condicional al modo de la
  Caja overnight** (ver Fase 5 más abajo).

El score sigue siendo **una síntesis organizada de evidencia**, no un
modelo predictivo validado a futuro: el test factor por factor (ver
`research/.../RESULTADOS_POR_FACTOR.md`) es la mejor evidencia disponible
sobre 388 días, no una garantía.

### 6b. Fase 5 — re-ponderación condicional al modo de la Caja (fallback-aware)

La Caja overnight tiene dos modos (ver sección 3): con historial dinámico
suficiente usa el backtest en vivo; sin él cae a un **valor de referencia
fijo** (56.7%, backtest manual de 515 días). El gate real de días lo pone
`box-capture.js`: `getBoxSummary()` devuelve resumen solo con **30 días**
acumulados; en `api/bias.js` hay además una salvaguarda defensiva
(`boxSummary.overnight.alcista.n >= 15`) que nunca es limitante en la
práctica porque el resumen ya viene filtrado.

No tiene sentido darle el 100% del peso liberado (0.35 → 0.85, el 77% del
total) a un valor que puede estar **congelado en una constante**. Regla
actual (`api/bias.js`, `computeFase2Weights()`, evaluada en cada request):

| Modo de Caja | Caja overnight | Nikkei | Regla |
|---|---|---|---|
| **Dinámico** (resumen real de box-capture) | 0.50 + 0.35 = **0.85** | 0.06 | El liberado va 100% a Caja (regla original de la Fase 2) |
| **Fallback** (constante) + Nikkei cointegrado | 0.50 + 0.175 = **0.675** | 0.06 + 0.175 = **0.235** | El liberado se reparte 50/50 entre Caja y Nikkei (único otro factor con evidencia real) |
| **Fallback** (constante) + Nikkei sin cointegración | 0.50 + 0.40 = **0.90** | 0.01 | Todo a Caja (Nikkei sin señal). El liberado es DINÁMICO: 0.35 de los 6 sin Bonferroni + 0.05 que Nikkei libera al caer a piso |

> **Peso liberado dinámico (no constante):** el pool se recalcula en cada
> request como `suma de (pesoOriginal - 0.01)` de TODOS los factores que
> ese día quedaron en piso. Los 6 que nunca pasaron Bonferroni liberan
> siempre 0.35; si además Nikkei no está cointegrado ese día, libera sus
> 0.05 extra (0.06 - 0.01). El cálculo vive en `pesoLiberado()` de
> `api/bias.js` y nunca pierde peso (la suma total siempre es 1.10).

La transición dinámico ↔ fallback es **automática**: se decide por
request, así que cuando `box-capture.js` acumule los 30 días hábiles
mínimos, el sistema pasa solo a la regla original (Caja 0.85). El modo
activo se reporta como `cajaModo: 'dinamico' | 'fallback'` en la respuesta
de `/api/bias`.

## 7. Umbrales de la etiqueta final

Los umbrales se **calibran contra la distribución del score**, no a ojo.
El cálculo se hace con
`research/.../compute-score-distribution-v2.js`: reconstruye el score
completo día por día (388 días, 2 años de Yahoo) con los pesos actuales
(Fase 2 + Fase 5) y las mismas reglas de lag de la Fase B, pero con
variación SIMULADA de los dos factores que la calibración original mantuvo
congelados (ver abajo).

### 7.1 Por qué se corrigió la calibración original

La calibración original (Fase 3, calculada el 2026-08-04) arrojó
**min=5 | max=16 | media=10.96 | desvío=3.09** — un score que en 2 años de
histórico NUNCA fue negativo. Eso no reflejaba el mercado real: reflejaba
que los dos factores de mayor peso combinado nunca variaron en esa
medición:

- **Noticias (IA)** se fijó en `overall_score: 0` todos los días (no hay
  historial reconstruible, mismo criterio que la Fase B — correcto para
  ese propósito).
- **Caja overnight** se fijó en su valor de referencia (56.7%) todos los
  días, una CONSTANTE.

Esas neutralizaciones son correctas para aislar el edge del resto de los
factores (Fase B), pero NO para calibrar umbrales de etiqueta que deben
reflejar lo que el score va a hacer de verdad en producción. A eso se sumó
que el **fix de Fase 5** cambió los pesos (Caja 0.675 / Nikkei 0.235 en
modo fallback, en vez de 0.85/0.06 con que se calibró la Fase 3), lo que ya
por sí solo ensanchó la distribución real a **min=-7 | max=24** aun con
Noticias en 0.

### 7.2 Nueva calibración (Fase 3 v2)

`compute-score-distribution-v2.js` genera variantes con muestreo
(bootstrap, 300 simulaciones):

- **Noticias (IA):** `~N(0,50)` truncada a `[-100,100]`. Es un **PROXY**:
  el KV de producción solo guarda `score`/`label` del día, no el
  `overall_score` de noticias, y el proyecto en Vercel lleva ~6 días, así
  que no hay historial real suficiente. Documentado como aproximación, no
  datos reales.
- **Caja overnight:** dos modos — valor de referencia fijo (56.7%, fallback
  como hoy) y rango dinámico simulado `~U(40,70)` (cuando box-capture.js
  pase a modo dinámico).

Resultados (comparados con la calibración original):

| Variante | min | max | media | desvío | p10 | p30 | p70 | p90 |
|---|---|---|---|---|---|---|---|---|
| *Original Fase 3 (congelados)* | *5* | *16* | *10.96* | *3.09* | *7* | *9* | *13* | *15* |
| A. Baseline (Noticias=0, Caja fija) | -7 | 24 | 9.48 | 10.36 | -5 | 2 | 16 | 22 |
| B. Noticias ~N(0,50) + Caja fija | -19 | 35 | 9.48 | 11.82 | -7 | 2 | 18 | 25 |
| **C. Noticias ~N(0,50) + Caja ~U(40,70) dinámico** | **-32** | **48** | **8.32** | **14.87** | **-12** | **-1** | **18** | **28** |

Se adoptó la **variante C**: es la más realista hacia adelante, porque
incluye la variación de Noticias (que ya ocurre en producción) y la de
Caja en modo dinámico (que ocurrirá en cuanto box-capture.js acumule los
30 días). La variante B (solo Noticias) subestima el rango de Caja dinámica
que ya está en el horizonte.

Regla objetiva de mapeo (NEUTRAL = 40% central de los datos):

| Score | Etiqueta |
|-------|----------|
| > 28 (score > p90) | ALCISTA FUERTE |
| 19 a 28 (p70 < score ≤ p90) | ALCISTA CON CAUTELA |
| 0 a 18 (p30 < score ≤ p70) | NEUTRAL |
| -11 a -1 (p10 < score ≤ p30) | BAJISTA CON CAUTELA |
| ≤ -12 (score ≤ p10) | BAJISTA FUERTE |

> **Cuándo recalibrar:** los valores numéricos quedaron fijos en
> `api/bias.js` (constante `THRESHOLDS`) y no se recalculan en cada
> request. Se recalibran **manualmente** cuando cambien materialmente los
> pesos de los factores o cada unos meses de datos nuevos acumulados.
>
> **ADVERTENCIA EXPLÍCITA:** estos umbrales deben recalibrarse en cuanto
> Caja overnight pase a modo dinámico de forma sostenida (no solo el
> primer día), porque va a aportar variación real que esta calibración
> todavía no vio — la variante C la simula con `U(40,70)`, pero la
> distribución real de box-capture.js puede diferir. Lo mismo si se
> acumulan días reales de Noticias que permitan reemplazar el proxy
> `N(0,50)` por la distribución real.

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

- **Caja overnight (el factor más pesado)**: hasta que se acumulen 30
  días hábiles de historial real vía `box-capture.js`, usa un valor de
  referencia fijo de un backtest manual de 515 días (56.7% de
  continuación). Se actualiza solo una vez alcanzado ese mínimo — ver
  `api/box-capture.js`. Para que ese peso enorme no recaiga sobre una
  constante congelada, en modo fallback el peso se reparte 50/50 con
  Nikkei (Caja 0.675 / Nikkei 0.235); al pasar a datos dinámicos, Caja
  recupera el 0.85 original (Fase 5, sección 6b).
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
  fuera de todo rango plausible (ej. ^KS11 > 12000); el código cae a un
  valor fijo de emergencia (`_invalid: true`) cuando esto pasa. Desde la
  **Fase 4**, cuando eso ocurre el factor se excluye por completo del
  score (ver sección 7b) en vez de enfriar el resultado con un dato
  falso. (El sanity check usa un rango amplio 2000-12000 para adaptarse
  al nivel real del índice, que en 2026 cotiza en ~4500-9000.)
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
