import json

import pytest

pytest.importorskip("fastapi")

from fastapi import HTTPException

from services import forecasters, model_store, train as train_module
from services.train import ServiceSpec, TrainRequest


@pytest.fixture
def trained(tmp_path, monkeypatch):
    """Redirects model storage to tmp_path and replaces training with a recorder."""
    monkeypatch.setattr(model_store, "FINETUNE_DIR", tmp_path)
    monkeypatch.setattr(model_store, "MANIFEST", tmp_path / "manifest.json")
    calls = {"series": {}, "fail": set()}

    def fake_train(model_type, series, directory):
        service = directory.name
        if service in calls["fail"]:
            raise RuntimeError("boom")
        directory.mkdir(parents=True, exist_ok=True)
        (directory / forecasters.META_FILE).write_text(json.dumps({"model": model_type}))
        (directory / forecasters.ARTIFACT_FILE[model_type]).write_text("model")
        calls["series"][service] = series.copy()
        return {"model": model_type}

    monkeypatch.setattr(forecasters, "train", fake_train)
    return calls


def request(services: dict[str, float], model: str = "gru") -> TrainRequest:
    return TrainRequest(services=[ServiceSpec(service=s, dailyRequestCount=d, model=model)
                                  for s, d in services.items()])


def test_reuses_models_for_the_same_settings(trained):
    assert train_module.train(request({"a": 100, "b": 50}))["cached"] is False
    assert train_module.train(request({"a": 100, "b": 50}))["cached"] is True


def test_retrains_after_a_failed_run(trained):
    train_module.train(request({"a": 100, "b": 50}))

    trained["fail"].add(model_store.service_dir("b").name)
    with pytest.raises(HTTPException):
        train_module.train(request({"a": 300, "b": 50}))
    trained["fail"].clear()

    # "a" now holds the failed run's model, so the earlier settings must not hit the cache.
    assert train_module.train(request({"a": 100, "b": 50}))["cached"] is False


def test_keeps_a_service_shape_when_another_is_renamed(trained):
    volumes = {f"s{i}": 1000 - i for i in range(9)}   # 9 > 7 groups: mixing method
    train_module.train(request(volumes))
    before = trained["series"][model_store.service_dir("s0").name]

    # "a" would sort first by name and shift every service down a Dirichlet row.
    renamed = {("a" if s == "s8" else s): d for s, d in volumes.items()}
    train_module.train(request(renamed))
    after = trained["series"][model_store.service_dir("s0").name]

    assert (before == after).all()
