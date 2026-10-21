"""Where per-service models live, and whether the current ones can be reused."""

from __future__ import annotations

import hashlib
import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).parent.parent
MODEL_DIR = ROOT / "models"              # mounted as a volume in deployment
FINETUNE_DIR = MODEL_DIR / "finetuned"
DATASET_DIR = MODEL_DIR / "dataset"      # user uploads, not consumed yet
NASA_DATASET = ROOT / "datasets" / "nasa1995_july_grouped.csv"
MANIFEST = FINETUNE_DIR / "manifest.json"

FINETUNE_DIR.mkdir(parents=True, exist_ok=True)
DATASET_DIR.mkdir(parents=True, exist_ok=True)


def service_dir(service: str) -> Path:
    # uniqueServiceName is "name\tnamespace\tversion"; the digest keeps distinct names
    # that sanitise to the same slug apart.
    slug = re.sub(r"[^A-Za-z0-9_-]+", ".", service).strip(".")
    digest = hashlib.sha1(service.encode("utf-8")).hexdigest()[:8]
    return FINETUNE_DIR / f"{slug}-{digest}"


def training_key(services: list[dict]) -> str:
    """Identifies one training run within a container's lifetime. The split depends on
    every service's daily count jointly, so the whole set is part of the key, not each
    service on its own. Code and library changes are covered by clear_trained_models()
    at startup instead. The dataset stays in the key because uploaded datasets will be
    able to change without a rebuild."""
    digest = hashlib.sha256()
    digest.update(NASA_DATASET.read_bytes())
    digest.update(json.dumps(services, sort_keys=True).encode("utf-8"))
    return digest.hexdigest()


def read_manifest() -> dict:
    try:
        return json.loads(MANIFEST.read_text("utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def write_manifest(manifest: dict) -> None:
    MANIFEST.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), "utf-8")


def clear_manifest() -> None:
    MANIFEST.unlink(missing_ok=True)


def clear_trained_models() -> None:
    """Drop every trained model. Run at startup: a new container may carry new training
    code or library versions, and the model volume outlives it."""
    # The manifest goes first and fails loudly: once it is gone no leftover model file
    # can be taken for a cache hit, even if one below refuses to be deleted.
    clear_manifest()
    shutil.rmtree(FINETUNE_DIR, ignore_errors=True)
    FINETUNE_DIR.mkdir(parents=True, exist_ok=True)
