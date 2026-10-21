"""One-step forecasters of the hourly percent-of-day share.

Ported from autoScaling-modelTraning (ARIMA/, Bi-LSTM/, GRU/), share-only inputs and
no normalisation (the target is already a percentage).

All three are trained on the NASA-derived series and then applied, with frozen
parameters, to the simulation's observed shares. predict() never lets slot t's own
value influence its prediction.
"""

from __future__ import annotations

import itertools
import json
import warnings
from pathlib import Path

import numpy as np

MODEL_TYPES = ("arima", "bilstm", "gru")
WINDOW = 10
SEED = 42

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
ARTIFACT_FILE = {"arima": "arima.pkl", "bilstm": "bilstm.keras", "gru": "gru.keras"}


def make_windows(series: np.ndarray, window: int = WINDOW) -> tuple[np.ndarray, np.ndarray]:
    """X[i] = series[i:i+window], y[i] = series[i+window]."""
    x = np.array([series[i:i + window] for i in range(len(series) - window)], dtype="float32")
    return x[..., np.newaxis], series[window:].astype("float32")


def window_inputs(shares: np.ndarray, window: int = WINDOW) -> tuple[np.ndarray, list[int]]:
    """Inputs for every slot that has a full window behind it, and those slots' indices."""
    targets = list(range(window, len(shares)))
    x = np.array([shares[t - window:t] for t in targets], dtype="float32")
    return x.reshape(len(targets), window, 1), targets


# -------------------------------------------------------------------- ARIMA --

def _fit_arima(x: np.ndarray, order: tuple[int, int, int]):
    from statsmodels.tsa.arima.model import ARIMA
    # Zero-mean processing: a constant term when no differencing removes the level.
    trend = "c" if order[1] == 0 else "n"
    return ARIMA(x, order=order, trend=trend).fit()


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
            res = _fit_arima(x, (p, d, q))
        except Exception:
            continue
        if best is None or res.aic < best[1].aic:
            best = ((p, d, q), res)
    if best is None:
        raise ValueError("no ARIMA order could be fitted")
    order, res = best
    lb_p = float(acorr_ljungbox(res.resid[d:], lags=[LJUNG_BOX_LAG])["lb_pvalue"].iloc[0])
    return {"order": list(order), "aic": float(res.aic), "ljung_box_p": lb_p}, res


def _predict_arima(directory: Path, meta: dict, shares: np.ndarray) -> list[float | None]:
    from statsmodels.tsa.arima.model import ARIMAResults
    res = ARIMAResults.load(directory / ARTIFACT_FILE["arima"])
    # apply() keeps the NASA-fitted coefficients and filters the new series; its fitted
    # values are one-step-ahead predictions, each using only earlier observations.
    fitted = np.asarray(res.apply(shares).fittedvalues, float)
    p, d, q = meta["order"]
    min_history = max(max(p, q) + d, 1)
    return [float(v) if t >= min_history and np.isfinite(v) else None
            for t, v in enumerate(fitted)]


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


def _predict_recurrent(model_type: str, directory: Path, shares: np.ndarray) -> list[float | None]:
    from tensorflow import keras
    predictions: list[float | None] = [None] * len(shares)
    x, targets = window_inputs(shares)
    if not targets:
        return predictions
    model = keras.models.load_model(directory / ARTIFACT_FILE[model_type])
    for t, value in zip(targets, model.predict(x, verbose=0).ravel()):
        predictions[t] = float(value) if np.isfinite(value) else None
    return predictions


# --------------------------------------------------------------------- API --

def train(model_type: str, series: np.ndarray, directory: Path) -> dict:
    if model_type not in MODEL_TYPES:
        raise ValueError(f"unknown model '{model_type}'")
    directory.mkdir(parents=True, exist_ok=True)
    series = np.asarray(series, float)

    if model_type == "arima":
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            details, res = _select_arima(series)
        res.save(directory / ARTIFACT_FILE["arima"])
    else:
        details = _train_recurrent(model_type, series, directory)

    meta = {"model": model_type, "trainingPoints": int(len(series)), **details}
    (directory / META_FILE).write_text(json.dumps(meta, indent=2), "utf-8")
    return meta


def predict(model_type: str, directory: Path, shares: list[float]) -> list[float | None]:
    meta = json.loads((directory / META_FILE).read_text("utf-8"))
    if meta["model"] != model_type:
        raise ValueError(f"trained model is '{meta['model']}', not '{model_type}'")
    values = np.asarray(shares, float)
    if model_type == "arima":
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            return _predict_arima(directory, meta, values)
    return _predict_recurrent(model_type, directory, values)


def is_trained(model_type: str, directory: Path) -> bool:
    return (directory / META_FILE).exists() and (directory / ARTIFACT_FILE[model_type]).exists()
