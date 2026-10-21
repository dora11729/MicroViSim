from services import model_store
from services.model_store import service_dir, training_key

Spec = {"service": "order\tdefault\tv1", "dailyRequestCount": 100, "model": "gru"}


def test_clears_every_trained_model(tmp_path, monkeypatch):
    finetuned = tmp_path / "finetuned"
    monkeypatch.setattr(model_store, "FINETUNE_DIR", finetuned)
    monkeypatch.setattr(model_store, "MANIFEST", finetuned / "manifest.json")
    (finetuned / "order-1a2b3c4d").mkdir(parents=True)
    (finetuned / "order-1a2b3c4d" / "gru.keras").write_text("model")
    (finetuned / "manifest.json").write_text("{}")

    model_store.clear_trained_models()

    assert list(finetuned.iterdir()) == []


def test_keys_on_every_training_setting():
    assert training_key([Spec]) == training_key([dict(Spec)])
    assert training_key([Spec]) != training_key([{**Spec, "dailyRequestCount": 101}])
    assert training_key([Spec]) != training_key([{**Spec, "model": "arima"}])
    assert training_key([Spec]) != training_key([{**Spec, "service": "pay\tdefault\tv1"}])


def test_keeps_names_that_sanitise_alike_apart():
    assert service_dir("a\tb\tc").name.startswith("a.b.c-")
    assert service_dir("a\tb\tc") != service_dir("a.b.c")
