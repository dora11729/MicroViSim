"""One-step forecasters of the hourly percent-of-day share, kept as a baseline for the
one-minute models in forecasters.py, which trains them alongside its own ("hourly").

The same three models, order selection and architectures, but trained on hourly shares
and predicting one hour ahead from the last WINDOW hours, so they see up to 10 hours of
history where the minute models' interpolated windows only carry the last two.
Parameters stay frozen, and hour t is built from hours 0..t-1 only.
"""

from __future__ import annotations

import json
import warnings
from pathlib import Path

import numpy as np

from services.forecasters import (ARTIFACT_FILE, BILSTM_TRAIN_RATIO, META_FILE, MODEL_TYPES, WINDOW,
                                  _arima, _fit_recurrent, _select_arima, make_windows)


def train(model_type: str, series: np.ndarray, directory: Path) -> dict:
    """Trains a one-hour-ahead model on an hourly percent-of-day series."""
    if model_type not in MODEL_TYPES:
        raise ValueError(f"unknown model '{model_type}'")
    directory.mkdir(parents=True, exist_ok=True)
    series = np.asarray(series, float)

    if model_type == "arima":
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            details, res = _select_arima(series)
        spec = {"order": details["order"], "params": np.asarray(res.params, float).tolist()}
        (directory / ARTIFACT_FILE["arima"]).write_text(json.dumps(spec, indent=2), "utf-8")
    else:
        x, y = make_windows(series)
        model, epochs = _fit_recurrent(
            model_type, x, y, lambda: make_windows(series[:int(len(series) * BILSTM_TRAIN_RATIO)]))
        model.save(directory / ARTIFACT_FILE[model_type])
        details = {"window": WINDOW, "epochs": epochs}

    meta = {"model": model_type, "trainingPoints": int(len(series)), **details}
    (directory / META_FILE).write_text(json.dumps(meta, indent=2), "utf-8")
    return meta


def predict(model_type: str, directory: Path, shares: list[float]) -> list[float | None]:
    """Next-hour share for every hour of `shares`; None until the model has enough history."""
    meta = json.loads((directory / META_FILE).read_text("utf-8"))
    if meta["model"] != model_type:
        raise ValueError(f"trained model is '{meta['model']}', not '{model_type}'")
    hourly = np.asarray(shares, float)

    if model_type == "arima":
        spec = json.loads((directory / ARTIFACT_FILE["arima"]).read_text("utf-8"))
        order = tuple(spec["order"])
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            # One-step predictions; fittedvalues[t] uses only hours before t.
            fitted = np.asarray(_arima(hourly, order).filter(np.asarray(spec["params"])).fittedvalues)
        p, d, q = order
        first = max(max(p, q) + d, 1)
        values = {t: fitted[t] for t in range(first, len(hourly))}
    else:
        from tensorflow import keras
        targets = range(WINDOW, len(hourly))
        values = {}
        if len(targets):
            model = keras.models.load_model(directory / ARTIFACT_FILE[model_type])
            x = np.stack([hourly[t - WINDOW:t] for t in targets])[..., np.newaxis].astype("float32")
            values = dict(zip(targets, model(x, training=False).numpy().ravel()))
    return [float(values[t]) if t in values and np.isfinite(values[t]) else None
            for t in range(len(hourly))]


def is_trained(model_type: str, directory: Path) -> bool:
    return (directory / META_FILE).exists() and (directory / ARTIFACT_FILE[model_type]).exists()
