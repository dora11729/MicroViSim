"""Split K source traffic groups into M target series, one per simulated service.

Ported from Traffic-Splitting/NASA1995/generate_split_traffic.py and
hourly_share_of_day.py.

* Method 1 (K >= M): each target is the sum of a set G_m of source groups,
  X_m(t) = alpha * beta_m * sum_{k in G_m} request_k(t), beta_m = pi_m / sum_{k in G_m} s_k.
  The assignment minimises max_m |ln beta_m| (ties: smaller sum of (ln beta_m)^2),
  by full enumeration when M^K <= 1e6, otherwise greedy plus local improvement.
* Method 2 (K < M): a seeded Dirichlet start table is scaled by IPF so rows sum
  to pi_m and columns to s_k; W = A / s_k and X_m(t) = alpha * sum_k W_mk * request_k(t).

alpha makes the average daily total equal sum D, so each target's average daily
total equals its D_m. Missing hours stay NaN.
"""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

ENUM_LIMIT = 10 ** 6
EPS = 1e-12
HOURS_PER_DAY = 24


@dataclass
class SourceTraffic:
    groups: list[str]
    bin_start: pd.Series
    valid: np.ndarray           # (hours,) False where missing = 1
    counts: np.ndarray          # (hours, K), NaN on missing hours


@dataclass
class SplitResult:
    method: int                 # 1 = assign groups, 2 = mixing matrix
    counts: np.ndarray          # (hours, M)
    weights: np.ndarray         # (M, K)
    alpha: float
    info: dict


def load_source(path: Path) -> SourceTraffic:
    df = pd.read_csv(path)
    groups = [c[:-len("_count")] for c in df.columns
              if c.endswith("_count") and c != "total_count"]
    valid = (df["missing"] == 0).to_numpy()
    counts = df[[f"{g}_count" for g in groups]].to_numpy(float)
    counts[~valid] = np.nan
    return SourceTraffic(groups, df["bin_start"], valid, counts)


# ---------------------------------------------------------------- method 1 --

def score(assign: list[int], s: np.ndarray, pi: np.ndarray) -> tuple[float, float] | None:
    """(max |ln beta|, sum (ln beta)^2) for an assignment k -> target; None if a target is empty."""
    got = np.zeros(len(pi))
    np.add.at(got, assign, s)
    if (got <= 0).any():
        return None
    lb = np.log(pi / got)
    return (round(float(np.abs(lb).max()), 12), round(float((lb ** 2).sum()), 12))


def assign_enumerate(s: np.ndarray, pi: np.ndarray, chunk: int = 1_000_000) -> list[int]:
    """Vectorised full enumeration of M^K assignments, same scoring and tie rule."""
    m_count, k_count = len(pi), len(s)
    total = m_count ** k_count
    powers = m_count ** np.arange(k_count - 1, -1, -1)    # itertools.product order
    best, best_key = None, None
    for start in range(0, total, chunk):
        idx = np.arange(start, min(start + chunk, total))
        a = (idx[:, None] // powers) % m_count           # (n, K) target of each group
        got = np.zeros((len(idx), m_count))
        for m in range(m_count):
            got[:, m] = (a == m) @ s
        ok = (got > 0).all(axis=1)
        with np.errstate(divide="ignore"):
            lb = np.log(pi / got)
        mx = np.where(ok, np.abs(lb).max(axis=1), np.inf).round(12)
        sq = np.where(ok, (lb ** 2).sum(axis=1), np.inf).round(12)
        i = np.lexsort((idx, sq, mx))[0]                 # min max, then min sq, then first
        key = (mx[i], sq[i])
        if best_key is None or key < best_key:
            best, best_key = a[i].tolist(), key
    return best


def assign_greedy(s: np.ndarray, pi: np.ndarray) -> list[int]:
    m_count, k_count = len(pi), len(s)
    order = sorted(range(m_count), key=lambda m: (-pi[m], m))
    assign = [-1] * k_count
    got = np.zeros(m_count)

    def err(m: int, extra: float) -> float:
        return abs(math.log(pi[m] / (got[m] + extra)))

    # One group per target; ties prefer a smaller group not exceeding pi_m, since a
    # shortfall can still be topped up later but an overshoot cannot be taken back.
    for m in order:
        free = [k for k in range(k_count) if assign[k] < 0]
        k = min(free, key=lambda k: (round(err(m, s[k]), 12), s[k] > pi[m], s[k], k))
        assign[k], got[m] = m, got[m] + s[k]

    # Largest remaining group goes to the best unfinished target.
    for k in sorted((k for k in range(k_count) if assign[k] < 0), key=lambda k: (-s[k], k)):
        open_ = [m for m in order if got[m] < pi[m] - EPS]
        if open_:
            m = min(open_, key=lambda m: (round(err(m, s[k]), 12), -(pi[m] - got[m]), m))
        else:
            m = min(order, key=lambda m: (round(err(m, s[k]) - err(m, 0), 12),
                                          -(pi[m] - got[m]), m))
        assign[k], got[m] = m, got[m] + s[k]

    # Local improvement by single moves and pairwise swaps.
    current = score(assign, s, pi)
    improved = True
    while improved:
        improved = False
        candidates = []
        for k in range(k_count):
            for m in range(m_count):
                if m != assign[k]:
                    trial = assign.copy(); trial[k] = m
                    candidates.append(trial)
        for a, b in itertools.combinations(range(k_count), 2):
            if assign[a] != assign[b]:
                trial = assign.copy(); trial[a], trial[b] = assign[b], assign[a]
                candidates.append(trial)
        for trial in candidates:
            sc = score(trial, s, pi)
            if sc is not None and sc < current:
                assign, current, improved = trial, sc, True
                break
    return assign


def method1(s: np.ndarray, pi: np.ndarray) -> tuple[np.ndarray, dict]:
    m_count, k_count = len(pi), len(s)
    exhaustive = m_count ** k_count <= ENUM_LIMIT
    assign = assign_enumerate(s, pi) if exhaustive else assign_greedy(s, pi)
    weights = np.zeros((m_count, k_count))
    beta = np.zeros(m_count)
    for m in range(m_count):
        members = [k for k in range(k_count) if assign[k] == m]
        beta[m] = pi[m] / s[members].sum()
        weights[m, members] = beta[m]
    info = {"search": "enumeration" if exhaustive else "greedy+local",
            "assignment": assign, "beta": beta.tolist()}
    return weights, info


# ---------------------------------------------------------------- method 2 --

def method2(s: np.ndarray, pi: np.ndarray, c: float, seed: int,
            tol: float = 1e-8, max_iter: int = 10_000) -> tuple[np.ndarray, dict]:
    rng = np.random.default_rng(seed)
    table = rng.dirichlet(np.full(len(s), c), size=len(pi))
    # A tiny c can underflow draws to exactly 0; an all-zero row or column would make
    # IPF divide 0 by 0, so keep every cell strictly positive.
    table = np.maximum(table, 1e-12)
    for iteration in range(1, max_iter + 1):
        table *= (pi / table.sum(axis=1))[:, None]
        table *= s / table.sum(axis=0)
        if (np.abs(table.sum(axis=1) - pi).max() < tol
                and np.abs(table.sum(axis=0) - s).max() < tol):
            break
    else:
        raise ValueError("IPF did not converge")
    return table / s, {"A": table.tolist(), "ipf_iterations": iteration}


# -------------------------------------------------------------------- split --

def split(source: SourceTraffic, daily: list[float], seed: int = 42, c: float = 1.0) -> SplitResult:
    daily_arr = np.asarray(daily, float)
    if len(daily_arr) == 0 or (daily_arr <= 0).any():
        raise ValueError("every target needs a positive daily request count")

    counts, valid = source.counts, source.valid
    s = np.nansum(counts[valid], axis=0) / np.nansum(counts[valid])
    if (s == 0).any():
        empty = [g for g, sk in zip(source.groups, s) if sk == 0]
        raise ValueError(f"source groups with no requests in valid hours: {empty}")

    pi = daily_arr / daily_arr.sum()
    hourly_total = counts.sum(axis=1)
    alpha = float(daily_arr.sum() / (np.nanmean(hourly_total[valid]) * HOURS_PER_DAY))

    if len(source.groups) >= len(daily_arr):
        method, (weights, info) = 1, method1(s, pi)
    else:
        method, (weights, info) = 2, method2(s, pi, c, seed)

    return SplitResult(method, alpha * counts @ weights.T, weights, alpha, info)


def daily_share_series(bin_start: pd.Series, valid: np.ndarray, counts: np.ndarray) -> np.ndarray:
    """Percent of the calendar day's traffic, per hour, over complete days only.

    A day is complete when it has 24 valid hourly bins; anything else (e.g. a log that
    stops mid-day) would make the percentages relative to a partial day.

    Any constant factor on counts (alpha, and beta in method 1) cancels out here, so the
    shares depend only on which source groups a target is made of and their weights.
    """
    date = bin_start.str[:10].to_numpy()   # the log's local calendar day
    frame = pd.DataFrame({"date": date, "valid": valid, "count": counts})
    complete = frame.groupby("date")["valid"].transform("sum") == HOURS_PER_DAY
    frame = frame[complete]
    daily = frame.groupby("date")["count"].transform("sum")
    return (frame["count"] / daily * 100).to_numpy(float)
