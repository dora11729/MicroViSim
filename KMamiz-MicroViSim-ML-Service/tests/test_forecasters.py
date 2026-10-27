import numpy as np
import pytest

from services import forecasters
from services.forecasters import (MINUTES_PER_HOUR, WINDOW, extended_line, linear_input_forecast,
                                  make_windows, minute_shares, predict, recursive_forecast, train)


def periodic_minutes(days: int, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    minutes = np.arange(days * 1440)
    return 100 / 1440 * (1 + 0.5 * np.sin(2 * np.pi * minutes / 1440)) + rng.normal(0, 0.005, len(minutes))


def last_input(x: np.ndarray) -> np.ndarray:
    return x[:, -1]


def test_pairs_each_window_with_the_next_value():
    series = np.arange(15, dtype=float)
    x, y = make_windows(series)
    assert x.shape == (5, WINDOW, 1)
    np.testing.assert_array_equal(x[0, :, 0], series[:WINDOW])
    np.testing.assert_array_equal(y, series[WINDOW:])


def test_spreads_each_hour_over_its_minutes_without_changing_its_total():
    hourly = np.array([6.0, 3.0, 4.0])
    hours = minute_shares(hourly).reshape(3, MINUTES_PER_HOUR)
    np.testing.assert_allclose(hours.sum(axis=1), hourly)
    np.testing.assert_allclose(hours[0], 6.0 / MINUTES_PER_HOUR)   # no earlier hour, no trend
    assert hours[2, -1] > hours[2, 0]                               # rising from 3 to 4


def test_flattens_a_steep_fall_just_enough_to_stay_non_negative():
    hours = minute_shares(np.array([10.0, 1.0])).reshape(2, MINUTES_PER_HOUR)
    assert hours[1].sum() == pytest.approx(1.0)
    assert hours[1, -1] == pytest.approx(0.0, abs=1e-12)
    assert hours[1].min() >= -1e-12


def test_carries_the_line_on_into_the_next_hour():
    hourly = np.array([3.0, 4.0])
    fitted = minute_shares(hourly)[MINUTES_PER_HOUR:]
    carried = extended_line(hourly, 2)
    np.testing.assert_allclose(np.diff(carried), np.diff(fitted).mean())
    assert carried[0] - fitted[-1] == pytest.approx(np.diff(fitted).mean())


def test_clips_the_carried_line_at_zero():
    assert extended_line(np.array([10.0, 1.0]), 2).min() == 0


def test_feeds_its_own_forecasts_back_when_recursive():
    windows = np.array([np.arange(WINDOW, dtype=float)])
    # Repeating the newest input keeps forecasting the last observed minute.
    np.testing.assert_allclose(recursive_forecast(last_input, windows), [MINUTES_PER_HOUR * (WINDOW - 1)])


def test_reads_the_carried_line_as_input_when_linear():
    windows = np.array([np.zeros(WINDOW)])
    lines = np.array([np.arange(1, MINUTES_PER_HOUR + 1, dtype=float)])
    # Minute j sees the line up to minute j-1, so the forecasts are 0, 1, ..., 59.
    np.testing.assert_allclose(linear_input_forecast(last_input, windows, lines),
                               [sum(range(MINUTES_PER_HOUR))])


@pytest.mark.parametrize("multi_step", ["recursive", "linearInput"])
def test_arima_builds_each_hour_from_earlier_hours_only(tmp_path, monkeypatch, multi_step):
    pytest.importorskip("statsmodels")
    monkeypatch.setattr(forecasters, "MAX_PQ", 1)
    train("arima", periodic_minutes(days=2), tmp_path)

    shares = 100 / 24 * (1 + 0.5 * np.sin(2 * np.pi * np.arange(12) / 24))
    changed = shares.copy()
    changed[6] += 5
    before = predict("arima", tmp_path, shares, multi_step)
    after = predict("arima", tmp_path, changed, multi_step)

    assert before[0] is None and after[0] is None
    assert after[1:7] == pytest.approx(before[1:7])
    assert after[7] != pytest.approx(before[7])
