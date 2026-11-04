"""Weighted kNN correction of a base forecast, a simplified Rectify (Ben Taieb & Hyndman 2012).

Rectify fits one corrector per step; here a single one corrects the hour's total, since
the system only uses that total. This is Rectify with one k shared by all 60 steps.
"""

from __future__ import annotations

import numpy as np

K_MAX = 50
HOLDOUT_TRAIN = 0.7


def _nearest(query: np.ndarray, features: np.ndarray, count: int) -> tuple[np.ndarray, np.ndarray]:
    """Distances to and indices of the `count` nearest features, nearest first."""
    distances = np.linalg.norm(query[:, np.newaxis, :] - features[np.newaxis, :, :], axis=2)
    order = np.argsort(distances, axis=1, kind="stable")[:, :count]
    return np.take_along_axis(distances, order, axis=1), order


def biweight_weights(distances: np.ndarray, k: int) -> np.ndarray:
    """Unnormalised biweight weights of the k nearest; d_max is the (k+1)-th distance."""
    distances = np.asarray(distances, float)
    with np.errstate(divide="ignore", invalid="ignore"):
        u = distances[:, :k] / distances[:, k:k + 1]
    weights = np.nan_to_num(np.where(u < 1, (1 - u ** 2) ** 2, 0.0))
    # Every neighbour at d_max (duplicates included) leaves nothing to weigh by.
    weights[weights.sum(axis=1) == 0] = 1.0
    return weights


def _estimate(distances: np.ndarray, order: np.ndarray, errors: np.ndarray, k: int) -> np.ndarray:
    weights = biweight_weights(distances, k)
    return (weights * errors[order[:, :k]]).sum(axis=1) / weights.sum(axis=1)


def select_k(features: np.ndarray, errors: np.ndarray) -> int:
    """k with the lowest error on the last 30%, using the first 70% as neighbours."""
    features, errors = np.asarray(features, float), np.asarray(errors, float)
    n_fit = int(len(features) * HOLDOUT_TRAIN)
    k_max = min(K_MAX, n_fit - 1)
    if k_max < 1 or n_fit == len(features):
        raise ValueError(f"{len(features)} samples are too few to choose k")
    # One search for every candidate k: they only differ in how many neighbours they read.
    distances, order = _nearest(features[n_fit:], features[:n_fit], k_max + 1)
    mse = [np.mean((_estimate(distances, order, errors[:n_fit], k) - errors[n_fit:]) ** 2)
           for k in range(1, k_max + 1)]
    return int(np.argmin(mse)) + 1


def correct(query: np.ndarray, features: np.ndarray, errors: np.ndarray, k: int) -> np.ndarray:
    """Estimated error of the base forecast at each query."""
    distances, order = _nearest(np.asarray(query, float), np.asarray(features, float), k + 1)
    return _estimate(distances, order, np.asarray(errors, float), k)
