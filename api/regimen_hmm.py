from http.server import BaseHTTPRequestHandler
import json
import logging
from dataclasses import dataclass
from pathlib import Path
import numpy as np
import pandas as pd
from hmmlearn import hmm
from sklearn.preprocessing import StandardScaler
import yfinance as yf

logger = logging.getLogger(__name__)

# ── Feature Config & FeatureEngineer (de nicots85/hmm/data/features.py) ─────

@dataclass
class FeatureConfig:
    atr_period: int = 14
    realised_vol_window: int = 20
    vol_profile_bins: int = 50
    vol_profile_window: int = 100
    log_ret_lag: int = 1
    skew_window: int = 60


class FeatureEngineer:
    def __init__(self, cfg: FeatureConfig | None = None) -> None:
        self.cfg = cfg or FeatureConfig()

    def transform(self, df: pd.DataFrame) -> pd.DataFrame:
        df = df.copy()
        df = self._add_log_returns(df)
        df = self._add_realised_volatility(df)
        df = self._add_atr(df)
        df = self._add_volume_profile_zscore(df)
        df = self._add_higher_moments(df)
        df.dropna(inplace=True)
        return df

    def get_hmm_observations(self, df: pd.DataFrame) -> np.ndarray:
        required = ["log_ret", "realised_vol", "atr_norm", "vol_profile_z"]
        missing = [c for c in required if c not in df.columns]
        if missing:
            raise ValueError(f"Missing features — run .transform() first: {missing}")
        return df[required].to_numpy(dtype=np.float64)

    def _add_log_returns(self, df: pd.DataFrame) -> pd.DataFrame:
        df["log_ret"] = np.log(df["close"] / df["close"].shift(self.cfg.log_ret_lag))
        return df

    def _add_realised_volatility(self, df: pd.DataFrame) -> pd.DataFrame:
        if "log_ret" not in df.columns:
            df = self._add_log_returns(df)
        df["realised_vol"] = df["log_ret"].rolling(self.cfg.realised_vol_window).std()
        return df

    def _add_atr(self, df: pd.DataFrame) -> pd.DataFrame:
        prev_close = df["close"].shift(1)
        tr = pd.concat(
            [
                df["high"] - df["low"],
                (df["high"] - prev_close).abs(),
                (df["low"] - prev_close).abs(),
            ],
            axis=1,
        ).max(axis=1)
        df["atr"] = tr.ewm(alpha=1.0 / self.cfg.atr_period, adjust=False).mean()
        df["atr_norm"] = df["atr"] / (df["close"] + 1e-9)
        return df

    def _add_volume_profile_zscore(self, df: pd.DataFrame) -> pd.DataFrame:
        w = self.cfg.vol_profile_window
        vol_roll_mean = df["volume"].rolling(w).mean()
        vol_roll_std = df["volume"].rolling(w).std()
        df["vol_profile_z"] = (df["volume"] - vol_roll_mean) / (vol_roll_std + 1e-9)
        return df

    def _add_higher_moments(self, df: pd.DataFrame) -> pd.DataFrame:
        w = self.cfg.skew_window
        df["realised_skew"] = df["log_ret"].rolling(w).skew()
        df["realised_kurt"] = df["log_ret"].rolling(w).kurt()
        return df


# ── Extended Observation Builder (12 features) ──────────────────────────────

def build_extended_observations(
    feat_df: pd.DataFrame,
    n_lags: int = 3,
) -> np.ndarray:
    df = feat_df.copy()
    for lag in range(1, n_lags + 1):
        df[f"ret_lag{lag}"] = df["log_ret"].shift(lag)

    df["vol_ratio"] = df["realised_vol"] / (
        df["realised_vol"].rolling(60).mean().shift(1) + 1e-9
    )

    r100_high = df["close"].rolling(100).max().shift(1)
    r100_low = df["close"].rolling(100).min().shift(1)
    df["price_pct"] = (df["close"] - r100_low) / (r100_high - r100_low + 1e-9)
    df["atr_ratio"] = df["atr"] / (df["atr"].rolling(60).mean().shift(1) + 1e-9)

    cols = [
        "log_ret",
        "realised_vol",
        "atr_norm",
        "vol_profile_z",
        "ret_lag1",
        "ret_lag2",
        "ret_lag3",
        "vol_ratio",
        "price_pct",
        "atr_ratio",
    ]
    for col in ["realised_skew", "realised_kurt"]:
        if col in df.columns:
            cols.append(col)

    sub = df[cols].dropna()
    return sub.to_numpy(dtype=np.float64), sub.index


# ── HMMRegimeDetector & Model Selection (de nicots85/hmm/models/hmm_regimes.py)

RegimeLabels = dict[int, str]


class HMMRegimeDetector:
    def __init__(
        self,
        n_regimes: int = 4,
        covariance_type: str = "diag",
        n_iter: int = 300,
        random_state: int = 42,
    ) -> None:
        self.n_regimes = n_regimes
        self.covariance_type = covariance_type
        self.n_iter = n_iter
        self.random_state = random_state
        self._model: hmm.GaussianHMM | None = None
        self._scaler: StandardScaler = StandardScaler()
        self._regime_labels: RegimeLabels = {}
        self._is_fitted: bool = False

    def fit(self, observations: np.ndarray) -> "HMMRegimeDetector":
        if np.isnan(observations).any():
            raise ValueError("observations contain NaN — run FeatureEngineer.transform() first.")
        X = self._scaler.fit_transform(observations)
        self._model = hmm.GaussianHMM(
            n_components=self.n_regimes,
            covariance_type=self.covariance_type,
            n_iter=self.n_iter,
            random_state=self.random_state,
            verbose=False,
        )
        self._model.fit(X)
        self._is_fitted = True
        self._regime_labels = self._assign_labels(observations)
        return self

    def predict_regimes(self, observations: np.ndarray) -> np.ndarray:
        self._assert_fitted()
        X = self._scaler.transform(observations)
        return self._model.predict(X)

    def predict_proba(self, observations: np.ndarray) -> np.ndarray:
        self._assert_fitted()
        X = self._scaler.transform(observations)
        _, posteriors = self._model.score_samples(X)
        return posteriors

    def get_current_regime(self, observations: np.ndarray) -> tuple[int, str]:
        regimes = self.predict_regimes(observations)
        idx = int(regimes[-1])
        return idx, self._regime_labels.get(idx, f"regime_{idx}")

    def bic(self, observations: np.ndarray) -> float:
        self._assert_fitted()
        X = self._scaler.transform(observations)
        T, D = X.shape
        log_lik = self._model.score(X)
        K = self.n_regimes
        if self.covariance_type == "diag":
            n_params = K * (K - 1) + K * D + K * D
        else:
            n_params = K * (K - 1) + K * D + K * D * (D + 1) // 2
        return -2 * log_lik * T + n_params * np.log(T)

    def _assert_fitted(self) -> None:
        if not self._is_fitted or self._model is None:
            raise RuntimeError("Model not fitted. Call .fit() first.")

    def _assign_labels(self, observations: np.ndarray) -> RegimeLabels:
        regimes = self.predict_regimes(observations)
        global_med_vol = np.median(observations[:, 1])
        labels: RegimeLabels = {}
        for k in range(self.n_regimes):
            mask = regimes == k
            if mask.sum() == 0:
                labels[k] = f"regime_{k}"
                continue
            mean_ret = observations[mask, 0].mean()
            mean_vol = observations[mask, 1].mean()
            direction = "bull" if mean_ret > 0 else "bear"
            vol_tag = "volatile" if mean_vol > global_med_vol else "calm"
            labels[k] = f"{direction}_{vol_tag}"
        return labels


def select_optimal_n_regimes(
    observations: np.ndarray,
    k_range: tuple[int, int] = (2, 4),
    covariance_type: str = "diag",
) -> tuple[int, list[float]]:
    bic_scores: list[float] = []
    best_k = k_range[0]
    best_bic = np.inf
    for k in range(k_range[0], k_range[1] + 1):
        detector = HMMRegimeDetector(n_regimes=k, covariance_type=covariance_type)
        try:
            detector.fit(observations)
            b = detector.bic(observations)
        except Exception as exc:
            logger.warning("HMM k=%d failed: %s", k, exc)
            bic_scores.append(np.nan)
            continue
        bic_scores.append(b)
        if b < best_bic:
            best_bic = b
            best_k = k
    return best_k, bic_scores


# ── Data Fetching & Processing ──────────────────────────────────────────────

def fetch_ndx_ohlcv() -> pd.DataFrame:
    raw = yf.download(
        "^NDX",
        period="730d",
        interval="1h",
        auto_adjust=True,
        progress=False,
    )
    if isinstance(raw.columns, pd.MultiIndex):
        raw.columns = raw.columns.get_level_values(0)
    raw.columns = [str(c).lower() for c in raw.columns]
    raw.index = pd.to_datetime(raw.index, utc=True)
    cols = ["open", "high", "low", "close", "volume"]
    return raw[cols].dropna()


def aggregate_to_4h(df_1h: pd.DataFrame) -> pd.DataFrame:
    n = len(df_1h)
    remainder = n % 4
    if remainder != 0:
        df_trimmed = df_1h.iloc[remainder:].copy()
    else:
        df_trimmed = df_1h.copy()

    groups = np.arange(len(df_trimmed)) // 4
    df_4h = df_trimmed.groupby(groups).agg(
        {
            "open": "first",
            "high": "max",
            "low": "min",
            "close": "last",
            "volume": "sum",
        }
    )
    df_4h.index = df_trimmed.groupby(groups).tail(1).index
    return df_4h


def analyze_timeframe(df: pd.DataFrame, timeframe_label: str) -> dict:
    if len(df) < 150:
        return {"regimen": "SIN_DATOS", "velas_utilizadas": 0, "n_estados": 0}

    fe = FeatureEngineer()
    df_feat = fe.transform(df)
    velas_utilizadas = int(len(df_feat))

    if velas_utilizadas < 150:
        return {
            "regimen": "SIN_DATOS",
            "velas_utilizadas": velas_utilizadas,
            "n_estados": 0,
        }

    # 12 features extendidas para ambas temporalidades si velas >= 150
    if velas_utilizadas >= 150:
        obs, obs_index = build_extended_observations(df_feat)
    else:
        obs = fe.get_hmm_observations(df_feat)
        obs_index = df_feat.index

    optimal_k, _ = select_optimal_n_regimes(obs, k_range=(2, 4), covariance_type="diag")
    detector = HMMRegimeDetector(n_regimes=optimal_k, covariance_type="diag")
    detector.fit(obs)

    regimes = detector.predict_regimes(obs)
    curr_idx = int(regimes[-1])
    detalle = detector._regime_labels.get(curr_idx, f"regime_{curr_idx}")
    probas = detector.predict_proba(obs)
    curr_prob = float(probas[-1][curr_idx])

    # Diagnóstico: ocupación de estados y auto-transición
    ocupacion = [int(x) for x in np.bincount(regimes, minlength=optimal_k)]
    auto_transicion = float(detector._model.transmat_[curr_idx, curr_idx])

    # Pasos 1, 2 y 3: Distribución histórica y último cambio de régimen
    labels_series = [detector._regime_labels.get(r, f"regime_{r}") for r in regimes]
    macro_series = [
        "ALCISTA" if l.startswith("bull") else "BAJISTA" if l.startswith("bear") else "INDEFINIDO"
        for l in labels_series
    ]

    count_alcista = int(sum(1 for m in macro_series if m == "ALCISTA"))
    count_bajista = int(sum(1 for m in macro_series if m == "BAJISTA"))
    distribucion_historica = {
        "ALCISTA": count_alcista,
        "BAJISTA": count_bajista,
    }

    cambios_idx = [i for i in range(1, len(macro_series)) if macro_series[i] != macro_series[i - 1]]
    if cambios_idx:
        last_change_ts = obs_index[cambios_idx[-1]]
        ultimo_cambio_regimen = str(pd.to_datetime(last_change_ts).strftime("%Y-%m-%d"))
    else:
        ultimo_cambio_regimen = None

    if detalle.startswith("bull"):
        regimen = "TENDENCIAL ALCISTA"
    elif detalle.startswith("bear"):
        regimen = "TENDENCIAL BAJISTA"
    else:
        regimen = "INDEFINIDO"

    return {
        "regimen": regimen,
        "detalle": detalle,
        "probabilidad": round(curr_prob, 2),
        "velas_utilizadas": velas_utilizadas,
        "n_estados": optimal_k,
        "ocupacion_estados": ocupacion,
        "auto_transicion_estado_actual": round(auto_transicion, 4),
        "distribucion_historica": distribucion_historica,
        "ultimo_cambio_regimen": ultimo_cambio_regimen,
    }


def compute_hmm_regimes() -> dict:
    df_1h = fetch_ndx_ohlcv()
    df_4h = aggregate_to_4h(df_1h)

    res_1h = analyze_timeframe(df_1h, "1h")
    res_4h = analyze_timeframe(df_4h, "4h")

    return {
        "1h": res_1h,
        "4h": res_4h,
    }


# ── Vercel Serverless Handler ───────────────────────────────────────────────

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            result = compute_hmm_regimes()
            payload = json.dumps(result).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(payload)
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))
