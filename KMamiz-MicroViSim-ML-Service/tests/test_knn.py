import numpy as np

from services.knn import HOLDOUT_TRAIN, biweight_weights, correct, select_k


def windows_and_errors(n: int, noise: float, seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
    # Minutes within a window move together, like real windows; the error follows their level.
    rng = np.random.default_rng(seed)
    level = rng.uniform(0, 1, n)
    features = level[:, np.newaxis] + rng.normal(0, 1e-4, (n, 10))
    return features, np.sin(4 * level) + rng.normal(0, noise, n)


def test_weighs_nearer_neighbours_more():
    np.testing.assert_allclose(biweight_weights(np.array([[0.0, 1.0, 2.0]]), 2), [[1.0, 0.5625]])


def test_gives_no_weight_at_the_bandwidth():
    np.testing.assert_allclose(biweight_weights(np.array([[1.0, 2.0, 2.0]]), 2), [[0.5625, 0.0]])


def test_weighs_equally_when_every_neighbour_is_at_the_bandwidth():
    np.testing.assert_allclose(biweight_weights(np.zeros((1, 3)), 2), [[1.0, 1.0]])


def test_chooses_many_neighbours_for_pure_noise():
    rng = np.random.default_rng(0)
    assert select_k(rng.uniform(0, 1, (400, 10)), rng.normal(0, 1, 400)) >= 20


def test_chooses_fewer_neighbours_without_noise():
    assert select_k(*windows_and_errors(400, noise=0)) < select_k(*windows_and_errors(400, noise=1))


def test_reduces_the_error_of_a_biased_base_forecast():
    features, errors = windows_and_errors(600, noise=0.1)
    n_fit = int(len(features) * HOLDOUT_TRAIN)
    k = select_k(features[:n_fit], errors[:n_fit])
    corrected = errors[n_fit:] - correct(features[n_fit:], features[:n_fit], errors[:n_fit], k)
    assert np.mean(corrected ** 2) < 0.5 * np.mean(errors[n_fit:] ** 2)
