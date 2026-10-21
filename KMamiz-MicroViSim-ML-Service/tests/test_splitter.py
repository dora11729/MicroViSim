import numpy as np
import pandas as pd

from services.model_store import NASA_DATASET
from services.splitter import SourceTraffic, daily_share_series, load_source, split

Source = load_source(NASA_DATASET)
CompleteDays = 27


def average_daily(result, source=Source):
    days = source.valid.sum() / 24
    return np.nansum(result.counts[source.valid], axis=0) / days


def mock_source(k_count: int, hours: int = 48, seed: int = 0) -> SourceTraffic:
    rng = np.random.default_rng(seed)
    counts = rng.integers(10, 500, size=(hours, k_count)).astype(float)
    bin_start = pd.Series([f"1995-07-{1 + h // 24:02d}T{h % 24:02d}:00:00-04:00"
                           for h in range(hours)])
    return SourceTraffic([f"g{k}" for k in range(k_count)], bin_start,
                         np.ones(hours, bool), counts)


def test_assigns_every_group_to_exactly_one_target():
    result = split(Source, [549805, 164941, 54980])
    assert result.method == 1
    assert result.info["search"] == "enumeration"
    assignment = result.info["assignment"]
    assert len(assignment) == len(Source.groups)
    assert set(assignment) == {0, 1, 2}


def test_matches_each_daily_total_when_assigning():
    daily = [549805, 164941, 54980]
    np.testing.assert_allclose(average_daily(split(Source, daily)), daily, rtol=1e-9)


def test_mixes_when_targets_outnumber_groups():
    daily = [1000 * (m + 1) for m in range(9)]
    result = split(Source, daily)
    assert result.method == 2
    np.testing.assert_allclose(result.weights.sum(axis=0), 1, atol=1e-8)
    np.testing.assert_allclose(average_daily(result), daily, rtol=1e-6)


def test_keeps_the_hourly_total_proportional_when_mixing():
    result = split(Source, [1000 * (m + 1) for m in range(9)])
    valid = Source.valid
    np.testing.assert_allclose(result.counts[valid].sum(axis=1),
                               result.alpha * Source.counts[valid].sum(axis=1), rtol=1e-8)


def test_falls_back_to_greedy_beyond_the_enumeration_limit():
    source = mock_source(k_count=10)
    result = split(source, [5, 4, 3, 2, 1])
    assert result.info["search"] == "greedy+local"
    assert set(result.info["assignment"]) == {0, 1, 2, 3, 4}


def test_replays_the_same_mix_for_the_same_seed():
    daily = [1000 * (m + 1) for m in range(9)]
    np.testing.assert_array_equal(split(Source, daily, seed=7).counts,
                                  split(Source, daily, seed=7).counts)
    assert not np.array_equal(split(Source, daily, seed=7).counts,
                              split(Source, daily, seed=8).counts)


def test_rejects_a_non_positive_daily_total():
    try:
        split(Source, [100, 0])
    except ValueError:
        return
    raise AssertionError("expected ValueError")


def test_keeps_complete_days_only():
    shares = daily_share_series(Source.bin_start, Source.valid, Source.counts[:, 0])
    assert len(shares) == CompleteDays * 24
    np.testing.assert_allclose(shares.reshape(CompleteDays, 24).sum(axis=1), 100)


def test_drops_a_day_with_a_missing_hour():
    valid = Source.valid.copy()
    valid[30] = False   # 1995-07-02 06:00
    shares = daily_share_series(Source.bin_start, valid, Source.counts[:, 0])
    assert len(shares) == (CompleteDays - 1) * 24
