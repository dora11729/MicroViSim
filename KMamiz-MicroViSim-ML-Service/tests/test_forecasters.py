import numpy as np

from services.forecasters import WINDOW, make_windows, train, predict, window_inputs


def periodic_series(days: int, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    hours = np.arange(days * 24)
    return 4.2 + 3 * np.sin(2 * np.pi * hours / 24) + rng.normal(0, 0.3, len(hours))


def test_pairs_each_window_with_the_next_value():
    series = np.arange(15, dtype=float)
    x, y = make_windows(series)
    assert x.shape == (5, WINDOW, 1)
    np.testing.assert_array_equal(x[0, :, 0], series[:WINDOW])
    np.testing.assert_array_equal(y, series[WINDOW:])


def test_feeds_each_slot_only_the_slots_before_it():
    shares = np.arange(14, dtype=float)
    x, targets = window_inputs(shares)
    assert targets == [10, 11, 12, 13]
    for row, t in zip(x, targets):
        np.testing.assert_array_equal(row[:, 0], shares[t - WINDOW:t])


def test_has_no_window_before_enough_history():
    x, targets = window_inputs(np.arange(WINDOW, dtype=float))
    assert targets == []


def test_arima_ignores_the_slot_it_predicts(tmp_path):
    import pytest
    pytest.importorskip("statsmodels")
    train("arima", periodic_series(days=6), tmp_path)

    shares = periodic_series(days=2, seed=1)
    changed = shares.copy()
    changed[30] += 50
    before, after = predict("arima", tmp_path, shares), predict("arima", tmp_path, changed)

    assert after[30] == pytest.approx(before[30])
    assert after[31] != pytest.approx(before[31])
    assert before[0] is None
