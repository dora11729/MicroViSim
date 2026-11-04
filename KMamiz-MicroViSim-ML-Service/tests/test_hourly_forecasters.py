import numpy as np
import pytest

from services import forecasters
from services.hourly_forecasters import predict, train


def periodic_hours(days: int, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    hours = np.arange(days * 24)
    return 100 / 24 * (1 + 0.5 * np.sin(2 * np.pi * hours / 24)) + rng.normal(0, 0.05, len(hours))


def test_arima_forecasts_each_hour_from_earlier_hours_only(tmp_path, monkeypatch):
    pytest.importorskip("statsmodels")
    monkeypatch.setattr(forecasters, "MAX_PQ", 1)
    train("arima", periodic_hours(days=5), tmp_path)

    shares = periodic_hours(days=1, seed=1)
    changed = shares.copy()
    changed[6] += 5
    before, after = predict("arima", tmp_path, shares), predict("arima", tmp_path, changed)

    assert before[0] is None
    assert after[:7] == before[:7]   # the filter is causal, so earlier values match exactly
    assert after[7] != pytest.approx(before[7])
