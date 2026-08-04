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

Un índice compuesto de 0 a ±100, construido a partir de **10 factores**
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
día, no siempre 1.0. Esto importa porque dos de los diez factores
(Nikkei y KOSPI) tienen **peso variable**: ver sección 4.

El resultado se redondea al entero más cercano.

## 3. Los 10 factores, en detalle

| # | Factor | Qué mide (`raw`) | Peso | Cómo se calcula el score |
|---|--------|-------------------|------|---------------------------|
| 1 | Caja overnight | % de veces que una ruptura alcista del rango overnight continuó (backtest propio, ver `box-capture.js`) | **0.40** | `(pctContinuación - 50) × 2` — 50% = score 0 (neutro), 100% = score 100 |
| 2 | VIX | Nivel del índice VIX | 0.10 | Escalones: <15→+80, <17→+50, <20→+10, <25→-50, ≥25→-80 |
| 3 | DXY (Dólar) | Nivel del índice dólar (proxy) | 0.08 | Escalones: <99→+60, <102→+10, <104→-30, ≥104→-60 |
| 4 | USD/JPY | % de cambio del día | 0.08 | Escalones: >1%→+50, >0.3%→+20, <-1.5%→-80, <-0.5%→-40, resto→0 |
| 5 | Nikkei | % de cambio del día | **0.06 o 0.01** (ver sección 4) | Solo si cointegrado con Nasdaq: >1%→+60, >0%→+30, <-1%→-60, <0%→-30. Si no cointegrado: **0** |
| 6 | KOSPI | % de cambio del día | **0.05 o 0.01** (ver sección 4) | Misma lógica que Nikkei |
| 7 | S&P 500 | % de cambio del día | 0.06 | Escalones: >1%→+50, >0.3%→+20, <-1%→-50, <-0.3%→-20, resto→0 |
| 8 | Momentum Nasdaq | % de cambio del día del propio ^NDX (incluye pre-market) | 0.10 | Escalones: >1.5%→+80, >0.5%→+40, >0.2%→+15, <-1.5%→-80, <-0.5%→-40, <-0.2%→-15, resto→0 |
| 9 | Crudo (WTI) | Precio en USD | 0.04 | Escalones: >100→-50, >85→-20, >70→-10, ≥60→+15, <60→+40 |
| 10 | Noticias (IA) | Score de sentimiento (-100 a +100) de Groq/Llama 3.3 sobre RSS + NewsAPI | 0.13 | Se usa directo, acotado a [-100, 100] |

> **¿Por qué ya no hay "Fear & Greed"?** Hasta la Fase 1, el índice
> ponderaba "VIX" (peso 0.10) y "Fear & Greed" (peso 0.05) como dos
> señales independientes. Pero en `api/market.js`, `fetchFearGreed()`
> calcula el valor de Fear & Greed **a partir del propio VIX** (buckets
> fijos sobre el precio del VIX), no desde un dato independiente. Eran la
> misma información contada dos veces, con 0.15 de peso combinado. Se
> eliminó el factor del cálculo ponderado, y los 0.05 liberados se
> reasignaron a "Caja overnight" (ahora 0.40), el único factor con
> evidencia estadística validada hasta ahora (Fase B). El dato de Fear &
> Greed **sigue devolviéndose** en la respuesta de la API dentro de
> `market.fearGreed` — solo como información, sin ponderar en el score.

## 4. El caso especial de Nikkei y KOSPI: peso condicional

A diferencia de los otros 8 factores, Nikkei y KOSPI **cambian de peso
según el resultado de un test de cointegración** (Engle-Granger, ver
`lib/stats.js`) contra Nasdaq, calculado ese mismo día con los datos
disponibles:

- **Si están cointegrados** (`isCointegrated: true`): peso completo
  (0.06 Nikkei, 0.05 KOSPI) y su score refleja su movimiento del día.
- **Si NO están cointegrados**: peso baja a 0.01 (casi no cuentan) y su
  score se fuerza a 0, sin importar cuánto se hayan movido.

**Por qué importa esto:** el informe de auditoría externa asumió pesos
fijos de 0.06/0.05 porque el día que lo generaron ambos estaban
cointegrados. Otro día, con cointegración distinta, la tabla de
contribuciones cambia — esto es esperado, no un error.

## 5. Los pesos NO están optimizados estadísticamente

Esto hay que decirlo sin vueltas: los 10 pesos (0.40, 0.10, 0.08...) son
**asignados por criterio propio** (cuánta importancia le damos a cada
factor en la práctica de trading), no el resultado de una regresión, un
modelo de optimización, ni ningún proceso estadístico que los derive de
datos históricos. El peso de 0.40 en "Caja overnight" refleja que es el
factor en el que más confiamos, no que un modelo haya demostrado que
explica el 40% de la varianza del movimiento del Nasdaq.

Esta es precisamente la pregunta que la **Fase B** (backtest retroactivo
parcial, en curso) busca empezar a responder: ¿el score, tal como está
ponderado hoy, predice algo real? Hasta que ese backtest exista, el
índice debe leerse como **una síntesis organizada de la opinión experta
del autor sobre qué mirar cada mañana**, no como un modelo validado
estadísticamente.

## 6. Umbrales de la etiqueta final

| Score | Etiqueta |
|-------|----------|
| > 60 | ALCISTA FUERTE |
| 20 a 60 | ALCISTA CON CAUTELA |
| -20 a 20 | NEUTRAL |
| -60 a -20 | BAJISTA CON CAUTELA |
| < -60 | BAJISTA FUERTE |

## 7. Limitaciones conocidas (activas al momento de escribir esto)

- **Caja overnight (peso 0.40, el factor más pesado)**: hasta que se
  acumulen 30 días hábiles de historial real vía `box-capture.js`, usa
  un valor de referencia fijo de un backtest manual de 515 días
  (56.7% de continuación). Se actualiza solo una vez alcanzado ese
  mínimo — ver `api/box-capture.js`.
- **El proxy de Fear & Greed ya no pondera** (ver nota en sección 3): se
  sigue calculando y devolviendo en `market.fearGreed` como dato
  informativo, pero no es el índice oficial de CNN (es un proxy del VIX,
  porque CNN bloquea el acceso automatizado) y desde la Fase 1 quedó
  fuera del cálculo del score para evitar doble conteo con el factor VIX.
- **KOSPI**: la fuente (Yahoo Finance) devuelve ocasionalmente un dato
  corrupto; el código cae a un valor fijo de emergencia
  (`_invalid: true`) cuando esto pasa. Pendiente de una fuente más
  confiable.
- **Sin intervalos de confianza ni bandas de error** en el score final
  — es un número puntual, no una estimación con incertidumbre
  cuantificada.
- **El factor "Noticias (IA)" no tiene historial reconstruible** — no
  hay archivo de qué noticia exacta salió cada día pasado, así que no
  puede formar parte de ningún backtest retroactivo (solo del tracking
  hacia adelante, ver Fase C).

## 8. Qué sigue (hoja de ruta de validación)

1. ✅ **Fase A (este documento)**: transparencia total de la
   metodología actual.
2. 🔄 **Fase B**: backtest retroactivo del sub-score estructural
   (todo excepto Noticias y Caja overnight, que ya tiene su propio
   backtest independiente) contra movimientos reales del Nasdaq,
   usando 1-2 años de datos diarios.
3. ⏳ **Fase C**: desde ahora, guardar el score completo (los 10
   factores, con noticias incluidas) todos los días, para construir un
   track record real de la fórmula completa a lo largo del tiempo.
