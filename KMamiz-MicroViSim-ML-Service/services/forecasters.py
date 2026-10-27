"""Forecasters of the next hour's percent-of-day share, built on one-minute models.

Ported from autoScaling-modelTraning (ARIMA/, Bi-LSTM/, GRU/), share-only inputs and
no normalisation (the target is already a percentage).

Each model is trained on a one-minute percent-of-day series and predicts one minute
ahead. The simulation only observes hourly shares, so predict():
  1. spreads every observed hour over its minutes along a straight line (minute_shares),
  2. forecasts the 60 minutes of the next hour, feeding steps 2..60 either the model's
     own predictions ("recursive") or that line carried on into the hour ("linearInput"),
  3. sums those minutes into the hour's share.
Parameters stay frozen, and hour t is built from hours 0..t-1 only.
"""

from __future__ import annotations

import itertools
import json
import warnings
from pathlib import Path
from typing import Callable

import numpy as np

MODEL_TYPES = ("arima", "bilstm", "gru")
MULTI_STEP = ("recursive", "linearInput")
WINDOW = 10
MINUTES_PER_HOUR = 60
SEED = 42

# Interpolation: how much of the trend between the last two hours each line keeps
TREND_STRENGTH = 0.5

# ARIMA, Box-Jenkins order selection
MAX_D = 2
MAX_PQ = 5
ADF_ALPHA = 0.05
LJUNG_BOX_LAG = 10

# Bi-LSTM: early stopping on a 70% split picks the epoch count for the 100% refit
BILSTM_UNITS = 30
BILSTM_BATCH = 64
BILSTM_MAX_EPOCHS = 50
BILSTM_PATIENCE = 5
BILSTM_TRAIN_RATIO = 0.7
BILSTM_VAL_SPLIT = 0.1

# GRU: fixed epoch count, no early stopping
GRU_UNITS = 50
GRU_BATCH = 512
GRU_EPOCHS = 200

META_FILE = "meta.json"
ARTIFACT_FILE = {"arima": "arima.json", "bilstm": "bilstm.keras", "gru": "gru.keras"}

# Minute m's offset from its hour's midpoint, in hours: m = 0..59 is the hour the line
# is fitted to, m = 60..119 the hour after it.
_OFFSETS = (np.arange(2 * MINUTES_PER_HOUR) + 0.5) / MINUTES_PER_HOUR - 0.5
_EDGE = 0.5 - 0.5 / MINUTES_PER_HOUR   # largest |offset| inside the fitted hour

Step = Callable[[np.ndarray], np.ndarray]   # (n, WINDOW) inputs -> (n,) next minute


def make_windows(series: np.ndarray, window: int = WINDOW) -> tuple[np.ndarray, np.ndarray]:
    """X[i] = series[i:i+window], y[i] = series[i+window]."""
    x = np.array([series[i:i + window] for i in range(len(series) - window)], dtype="float32")
    return x[..., np.newaxis], series[window:].astype("float32")


# ------------------------------------------------------------ interpolation --

def _line(hourly: np.ndarray, k: int) -> tuple[float, float]:
    """Hour k's level H and trend term phi * D, D = H_k - H_{k-1} (0 for the first hour)."""
    level = float(hourly[k])
    trend = level - float(hourly[k - 1]) if k > 0 else 0.0
    phi = TREND_STRENGTH
    # A steep fall would take the hour's last minute below 0; flatten the line just
    # enough to end at 0, which still keeps the hour's total at H.
    if level <= 0:
        phi = 0.0
    elif abs(trend) * phi * _EDGE > level:
        phi = level / (abs(trend) * _EDGE)
    return level, phi * trend


def minute_shares(hourly: np.ndarray) -> np.ndarray:
    """x_m = [H + phi * D * ((m + 0.5) / 60 - 0.5)] / 60 for every hour; each sums to H."""
    minutes = np.empty(len(hourly) * MINUTES_PER_HOUR)
    for k in range(len(hourly)):
        level, trend = _line(hourly, k)
        minutes[k * MINUTES_PER_HOUR:(k + 1) * MINUTES_PER_HOUR] = (
            level + trend * _OFFSETS[:MINUTES_PER_HOUR]) / MINUTES_PER_HOUR
    return minutes


def extended_line(hourly: np.ndarray, t: int) -> np.ndarray:
    """Hour t-1's line carried on through hour t, clipped at 0."""
    level, trend = _line(hourly, t - 1)
    return np.maximum((level + trend * _OFFSETS[MINUTES_PER_HOUR:]) / MINUTES_PER_HOUR, 0)


# --------------------------------------------------------------- multi-step --

def recursive_forecast(step: Step, windows: np.ndarray) -> np.ndarray:
    """Sum of 60 one-minute forecasts, each fed back as the newest input."""
    x = np.array(windows, float)
    total = np.zeros(len(x))
    for _ in range(MINUTES_PER_HOUR):
        y = np.asarray(step(x), float)
        total += y
        x = np.concatenate([x[:, 1:], y[:, np.newaxis]], axis=1)
    return total


def linear_input_forecast(step: Step, windows: np.ndarray, lines: np.ndarray) -> np.ndarray:
    """Sum of 60 one-minute forecasts whose inputs come from the extended line."""
    sequence = np.concatenate([windows, lines], axis=1)
    x = np.stack([sequence[:, j:j + WINDOW] for j in range(MINUTES_PER_HOUR)], axis=1)
    y = np.asarray(step(x.reshape(-1, WINDOW)), float)
    return y.reshape(len(windows), MINUTES_PER_HOUR).sum(axis=1)


# -------------------------------------------------------------------- ARIMA --

def _arima(endog: np.ndarray, order: tuple[int, int, int]):
    from statsmodels.tsa.arima.model import ARIMA
    # Zero-mean processing: a constant term when no differencing removes the level.
    trend = "c" if order[1] == 0 else "n"
    return ARIMA(endog, order=order, trend=trend)


def _choose_d(x: np.ndarray) -> int:
    from statsmodels.tsa.stattools import adfuller
    for d in range(MAX_D + 1):
        if adfuller(np.diff(x, n=d))[1] < ADF_ALPHA:
            return d
    return MAX_D


def _select_arima(x: np.ndarray) -> tuple[dict, object]:
    from statsmodels.stats.diagnostic import acorr_ljungbox
    d = _choose_d(x)
    best = None
    for p, q in itertools.product(range(MAX_PQ + 1), repeat=2):
        try:
            res = _arima(x, (p, d, q)).fit()
        except Exception:
            continue
        if best is None or res.aic < best[1].aic:
            best = ((p, d, q), res)
    if best is None:
        raise ValueError("no ARIMA order could be fitted")
    order, res = best
    lb_p = float(acorr_ljungbox(res.resid[d:], lags=[LJUNG_BOX_LAG])["lb_pvalue"].iloc[0])
    return {"order": list(order), "aic": float(res.aic), "ljung_box_p": lb_p}, res


def _train_arima(series: np.ndarray, directory: Path) -> dict:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        details, res = _select_arima(series)
    # Order and coefficients are all prediction needs; a pickled result also carries
    # the whole training series and filter state (over 100 MB for a minute series).
    spec = {"order": details["order"], "paramNames": list(res.model.param_names),
            "params": np.asarray(res.params, float).tolist()}
    (directory / ARTIFACT_FILE["arima"]).write_text(json.dumps(spec, indent=2), "utf-8")
    return details


def _predict_arima(directory: Path, hourly: np.ndarray, multi_step: str) -> np.ndarray:
    spec = json.loads((directory / ARTIFACT_FILE["arima"]).read_text("utf-8"))
    order, params = tuple(spec["order"]), np.asarray(spec["params"], float)
    minutes = minute_shares(hourly)
    totals = []
    # filter() runs the frozen coefficients over a new series, the same as apply().
    for t in range(1, len(hourly)):
        history = minutes[:t * MINUTES_PER_HOUR]
        if multi_step == "recursive":
            forecast = _arima(history, order).filter(params).forecast(MINUTES_PER_HOUR)
        else:
            observed = np.concatenate([history, extended_line(hourly, t)])
            # One-step predictions over the line; each uses only the minutes before it.
            forecast = np.asarray(_arima(observed, order).filter(params).fittedvalues)[len(history):]
        totals.append(float(np.sum(forecast)))
    return np.array(totals)


# ------------------------------------------------------------ Bi-LSTM / GRU --

def _build_recurrent(model_type: str):
    from tensorflow import keras
    if model_type == "bilstm":
        layer = keras.layers.Bidirectional(
            keras.layers.LSTM(BILSTM_UNITS, activation="relu", recurrent_activation="sigmoid",
                              return_sequences=False),
            merge_mode="concat")
    else:
        layer = keras.layers.GRU(GRU_UNITS, activation="relu", recurrent_activation="sigmoid",
                                 return_sequences=False, reset_after=True)
    model = keras.Sequential([keras.layers.Input(shape=(WINDOW, 1)), layer, keras.layers.Dense(1)])
    model.compile(optimizer="adam", loss="mse")
    return model


def _bilstm_best_epoch(series: np.ndarray) -> int:
    from tensorflow import keras
    keras.utils.set_random_seed(SEED)
    x, y = make_windows(series[:int(len(series) * BILSTM_TRAIN_RATIO)])
    early = keras.callbacks.EarlyStopping(monitor="val_loss", patience=BILSTM_PATIENCE,
                                          restore_best_weights=True)
    hist = _build_recurrent("bilstm").fit(
        x, y, epochs=BILSTM_MAX_EPOCHS, batch_size=BILSTM_BATCH,
        validation_split=BILSTM_VAL_SPLIT, callbacks=[early], shuffle=False, verbose=0)
    return int(np.argmin(hist.history["val_loss"])) + 1


def _train_recurrent(model_type: str, series: np.ndarray, directory: Path) -> dict:
    from tensorflow import keras
    if model_type == "bilstm":
        epochs, batch = _bilstm_best_epoch(series), BILSTM_BATCH
    else:
        epochs, batch = GRU_EPOCHS, GRU_BATCH
    keras.utils.set_random_seed(SEED)
    x, y = make_windows(series)
    model = _build_recurrent(model_type)
    model.fit(x, y, epochs=epochs, batch_size=batch, shuffle=False, verbose=0)
    model.save(directory / ARTIFACT_FILE[model_type])
    return {"window": WINDOW, "epochs": epochs}


def _predict_recurrent(model_type: str, directory: Path, hourly: np.ndarray,
                       multi_step: str) -> np.ndarray:
    from tensorflow import keras
    model = keras.models.load_model(directory / ARTIFACT_FILE[model_type])

    def step(x: np.ndarray) -> np.ndarray:
        return model(x[..., np.newaxis].astype("float32"), training=False).numpy().ravel()

    minutes = minute_shares(hourly)
    targets = range(1, len(hourly))
    windows = np.stack([minutes[t * MINUTES_PER_HOUR - WINDOW:t * MINUTES_PER_HOUR] for t in targets])
    if multi_step == "recursive":
        return recursive_forecast(step, windows)
    return linear_input_forecast(step, windows, np.stack([extended_line(hourly, t) for t in targets]))


# --------------------------------------------------------------------- API --

def train(model_type: str, series: np.ndarray, directory: Path) -> dict:
    """Trains a one-minute model on a percent-of-day series."""
    if model_type not in MODEL_TYPES:
        raise ValueError(f"unknown model '{model_type}'")
    directory.mkdir(parents=True, exist_ok=True)
    series = np.asarray(series, float)

    if model_type == "arima":
        details = _train_arima(series, directory)
    else:
        details = _train_recurrent(model_type, series, directory)

    meta = {"model": model_type, "trainingPoints": int(len(series)), **details}
    (directory / META_FILE).write_text(json.dumps(meta, indent=2), "utf-8")
    return meta


def predict(model_type: str, directory: Path, shares: list[float],
            multi_step: str = "recursive") -> list[float | None]:
    """Next-hour share for every hour of `shares`; None for hour 0, which has no past."""
    meta = json.loads((directory / META_FILE).read_text("utf-8"))
    if meta["model"] != model_type:
        raise ValueError(f"trained model is '{meta['model']}', not '{model_type}'")
    if multi_step not in MULTI_STEP:
        raise ValueError(f"unknown multi-step strategy '{multi_step}'")
    hourly = np.asarray(shares, float)
    if len(hourly) < 2:
        return [None] * len(hourly)

    if model_type == "arima":
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            totals = _predict_arima(directory, hourly, multi_step)
    else:
        totals = _predict_recurrent(model_type, directory, hourly, multi_step)
    return [None] + [float(v) if np.isfinite(v) else None for v in totals]


def is_trained(model_type: str, directory: Path) -> bool:
    return (directory / META_FILE).exists() and (directory / ARTIFACT_FILE[model_type]).exists()
