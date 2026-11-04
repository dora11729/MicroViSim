"""Forecasters of the next hour's percent-of-day share, built on one-minute models.

Ported from autoScaling-modelTraning (ARIMA/, Bi-LSTM/, GRU/), share-only inputs and
no normalisation (the target is already a percentage).

Each model is trained on a one-minute percent-of-day series and predicts one minute
ahead. The simulation only observes hourly shares, so predict():
  1. spreads every observed hour over its minutes along a straight line (minute_shares),
  2. forecasts the next hour with one of four strategies:
     - "recursive":   60 one-minute steps, each fed the model's own earlier predictions
     - "linearInput": 60 one-minute steps, each fed the line carried on into the hour
     - "rectify":     the recursive total plus a kNN estimate of its error (knn.py)
     - "direct":      six models, each forecasting one 10-minute block's total; for
                      ARIMA, a linear regression on the last two hours
  3. sums those minutes or blocks into the hour's share.
"hourly" skips the minutes: a model trained on hourly shares (hourly_forecasters.py),
kept as a baseline for the four above.
rectify and direct are trained on samples starting on the hour, with interpolated inputs,
as predict() sees them. Parameters stay frozen, and hour t is built from hours 0..t-1 only.
"""

from __future__ import annotations

import itertools
import json
import warnings
from pathlib import Path
from typing import Callable

import numpy as np

from services import knn

MODEL_TYPES = ("arima", "bilstm", "gru")
MULTI_STEP = ("recursive", "linearInput", "rectify", "direct", "hourly")
WINDOW = 10
MINUTES_PER_HOUR = 60
SEED = 42

DIRECT_BLOCKS = 6
BLOCK_MINUTES = MINUTES_PER_HOUR // DIRECT_BLOCKS

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
RECTIFY_FILE = "rectify.npz"
HOURLY_DIR = "hourly"
DIRECT_FILES = {"arima": ["direct.npz"],
                **{m: [f"direct_{b}.keras" for b in range(DIRECT_BLOCKS)] for m in ("bilstm", "gru")}}

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

def hour_windows(minutes: np.ndarray, targets: range) -> np.ndarray:
    """The WINDOW minutes before each target hour starts."""
    return np.stack([minutes[t * MINUTES_PER_HOUR - WINDOW:t * MINUTES_PER_HOUR] for t in targets])


def _hour_starts(hourly: np.ndarray) -> tuple[np.ndarray, range, np.ndarray]:
    """Interpolated minutes, the hours 1..T-1 to forecast, and the window before each."""
    minutes = minute_shares(hourly)
    targets = range(1, len(hourly))
    return minutes, targets, hour_windows(minutes, targets)


def hour_start_samples(series: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """A one-minute training series as predict() would see it: its hourly shares, and
    the true minutes of every hour from hour 1 on, shaped (T-1, 60)."""
    series = np.asarray(series, float)
    if len(series) % MINUTES_PER_HOUR:
        raise ValueError(f"series of {len(series)} minutes is not made of whole hours")
    hourly = series.reshape(-1, MINUTES_PER_HOUR).sum(axis=1)
    return hourly, series[MINUTES_PER_HOUR:].reshape(-1, MINUTES_PER_HOUR)


def block_totals(minutes: np.ndarray) -> np.ndarray:
    """(n, 60) minutes -> (n, DIRECT_BLOCKS) totals of each 10-minute block."""
    return minutes.reshape(len(minutes), DIRECT_BLOCKS, BLOCK_MINUTES).sum(axis=2)


def recursive_path(step: Step, windows: np.ndarray) -> np.ndarray:
    """60 one-minute forecasts, each fed back as the newest input; shape (n, 60)."""
    x = np.array(windows, float)
    path = np.empty((len(x), MINUTES_PER_HOUR))
    for j in range(MINUTES_PER_HOUR):
        path[:, j] = np.asarray(step(x), float)
        x = np.concatenate([x[:, 1:], path[:, j:j + 1]], axis=1)
    return path


def recursive_forecast(step: Step, windows: np.ndarray) -> np.ndarray:
    """Sum of 60 one-minute forecasts, each fed back as the newest input."""
    return recursive_path(step, windows).sum(axis=1)


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


def _load_arima(directory: Path) -> tuple[tuple[int, int, int], np.ndarray]:
    spec = json.loads((directory / ARTIFACT_FILE["arima"]).read_text("utf-8"))
    return tuple(spec["order"]), np.asarray(spec["params"], float)


# filter() runs the frozen coefficients over a new series, the same as apply().
def _arima_paths(directory: Path, minutes: np.ndarray, targets: range) -> np.ndarray:
    order, params = _load_arima(directory)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return np.stack([
            np.asarray(_arima(minutes[:t * MINUTES_PER_HOUR], order).filter(params)
                       .forecast(MINUTES_PER_HOUR)) for t in targets])


def _arima_linear_input(directory: Path, hourly: np.ndarray, minutes: np.ndarray,
                        targets: range) -> np.ndarray:
    order, params = _load_arima(directory)
    totals = []
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        for t in targets:
            history = minutes[:t * MINUTES_PER_HOUR]
            observed = np.concatenate([history, extended_line(hourly, t)])
            # One-step predictions over the line; each uses only the minutes before it.
            fitted = np.asarray(_arima(observed, order).filter(params).fittedvalues)
            totals.append(float(np.sum(fitted[len(history):])))
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


def _bilstm_best_epoch(x: np.ndarray, y: np.ndarray) -> int:
    from tensorflow import keras
    keras.utils.set_random_seed(SEED)
    early = keras.callbacks.EarlyStopping(monitor="val_loss", patience=BILSTM_PATIENCE,
                                          restore_best_weights=True)
    hist = _build_recurrent("bilstm").fit(
        x, y, epochs=BILSTM_MAX_EPOCHS, batch_size=BILSTM_BATCH,
        validation_split=BILSTM_VAL_SPLIT, callbacks=[early], shuffle=False, verbose=0)
    return int(np.argmin(hist.history["val_loss"])) + 1


def _fit_recurrent(model_type: str, x: np.ndarray, y: np.ndarray,
                   epoch_search: Callable[[], tuple[np.ndarray, np.ndarray]]):
    """epoch_search gives the 70% split Bi-LSTM picks its epoch count on."""
    from tensorflow import keras
    if model_type == "bilstm":
        epochs, batch = _bilstm_best_epoch(*epoch_search()), BILSTM_BATCH
    else:
        epochs, batch = GRU_EPOCHS, GRU_BATCH
    keras.utils.set_random_seed(SEED)
    model = _build_recurrent(model_type)
    model.fit(x, y, epochs=epochs, batch_size=batch, shuffle=False, verbose=0)
    return model, epochs


def _train_recurrent(model_type: str, series: np.ndarray, directory: Path) -> dict:
    x, y = make_windows(series)
    model, epochs = _fit_recurrent(
        model_type, x, y, lambda: make_windows(series[:int(len(series) * BILSTM_TRAIN_RATIO)]))
    model.save(directory / ARTIFACT_FILE[model_type])
    return {"window": WINDOW, "epochs": epochs}


def _recurrent_step(path: Path) -> Step:
    from tensorflow import keras
    model = keras.models.load_model(path)

    def step(x: np.ndarray) -> np.ndarray:
        return model(x[..., np.newaxis].astype("float32"), training=False).numpy().ravel()
    return step


def _recurrent_linear_input(model_type: str, directory: Path, hourly: np.ndarray,
                            targets: range, windows: np.ndarray) -> np.ndarray:
    lines = np.stack([extended_line(hourly, t) for t in targets])
    return linear_input_forecast(_recurrent_step(directory / ARTIFACT_FILE[model_type]), windows, lines)


# ---------------------------------------------------------- rectify, direct --

def _base_paths(model_type: str, directory: Path, minutes: np.ndarray, targets: range,
                windows: np.ndarray) -> np.ndarray:
    """The recursive 60-minute forecast of every target hour; shape (n, 60)."""
    if model_type == "arima":
        return _arima_paths(directory, minutes, targets)
    return recursive_path(_recurrent_step(directory / ARTIFACT_FILE[model_type]), windows)


def _train_rectify(model_type: str, directory: Path, hourly: np.ndarray, truth: np.ndarray) -> int:
    minutes, targets, windows = _hour_starts(hourly)
    errors = truth.sum(axis=1) - _base_paths(model_type, directory, minutes, targets, windows).sum(axis=1)
    k = knn.select_k(windows, errors)
    np.savez(directory / RECTIFY_FILE, features=windows, errors=errors, k=k)
    return k


def _predict_rectify(model_type: str, directory: Path, minutes: np.ndarray, targets: range,
                     windows: np.ndarray) -> np.ndarray:
    with np.load(directory / RECTIFY_FILE) as stored:
        features, errors, k = stored["features"], stored["errors"], int(stored["k"])
    base = _base_paths(model_type, directory, minutes, targets, windows).sum(axis=1)
    return base + knn.correct(windows, features, errors, k)


def last_two_hours(hourly: np.ndarray, targets: range) -> np.ndarray:
    """(1, H_{t-1}, H_{t-2}) per target hour: all an interpolated window carries, and,
    unlike its 10 near-collinear minutes, a well-posed regression. Hour 1 repeats hour 0
    for the missing hour -1, as hour 0's interpolation has no trend."""
    return np.array([[1.0, hourly[t - 1], hourly[max(t - 2, 0)]] for t in targets])


def _train_direct(model_type: str, directory: Path, hourly: np.ndarray, truth: np.ndarray) -> None:
    _, targets, windows = _hour_starts(hourly)
    y = block_totals(truth)
    if model_type == "arima":
        # ARIMA has no direct form; a least-squares AR(2) regression on the hours per block
        # stands in for it.
        coef, *_ = np.linalg.lstsq(last_two_hours(hourly, targets), y, rcond=None)
        np.savez(directory / DIRECT_FILES["arima"][0], coef=coef.T)
        return
    x = windows[..., np.newaxis].astype("float32")
    n_search = int(len(x) * BILSTM_TRAIN_RATIO)
    for b, name in enumerate(DIRECT_FILES[model_type]):
        target = y[:, b].astype("float32")
        model, _ = _fit_recurrent(model_type, x, target, lambda: (x[:n_search], target[:n_search]))
        model.save(directory / name)


def _predict_direct(model_type: str, directory: Path, hourly: np.ndarray, targets: range,
                    windows: np.ndarray) -> np.ndarray:
    if model_type == "arima":
        with np.load(directory / DIRECT_FILES["arima"][0]) as stored:
            blocks = last_two_hours(hourly, targets) @ stored["coef"].T
    else:
        blocks = np.column_stack([_recurrent_step(directory / name)(windows)
                                  for name in DIRECT_FILES[model_type]])
    return blocks.sum(axis=1)


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
    hourly, truth = hour_start_samples(series)
    k = _train_rectify(model_type, directory, hourly, truth)
    _train_direct(model_type, directory, hourly, truth)
    from services import hourly_forecasters   # it imports this module
    hourly_forecasters.train(model_type, hourly, directory / HOURLY_DIR)

    meta = {"model": model_type, "trainingPoints": int(len(series)), **details,
            "hourSamples": int(len(truth)), "rectifyK": k}
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
    if multi_step == "hourly":
        from services import hourly_forecasters
        return hourly_forecasters.predict(model_type, directory / HOURLY_DIR, shares)
    hourly = np.asarray(shares, float)
    if len(hourly) < 2:
        return [None] * len(hourly)

    minutes, targets, windows = _hour_starts(hourly)
    if multi_step == "recursive":
        totals = _base_paths(model_type, directory, minutes, targets, windows).sum(axis=1)
    elif multi_step == "linearInput":
        totals = (_arima_linear_input(directory, hourly, minutes, targets) if model_type == "arima"
                  else _recurrent_linear_input(model_type, directory, hourly, targets, windows))
    elif multi_step == "rectify":
        totals = _predict_rectify(model_type, directory, minutes, targets, windows)
    else:
        totals = _predict_direct(model_type, directory, hourly, targets, windows)
    # Left unclipped for every strategy alike; the backend clips the hour's share at 0.
    return [None] + [float(v) if np.isfinite(v) else None for v in totals]


def artifact_paths(model_type: str, directory: Path) -> list[Path]:
    """Every file train() writes; all must exist for a model to count as trained."""
    names = [META_FILE, ARTIFACT_FILE[model_type], RECTIFY_FILE, *DIRECT_FILES[model_type],
             f"{HOURLY_DIR}/{META_FILE}", f"{HOURLY_DIR}/{ARTIFACT_FILE[model_type]}"]
    return [directory / name for name in names]


def is_trained(model_type: str, directory: Path) -> bool:
    return all(path.exists() for path in artifact_paths(model_type, directory))
