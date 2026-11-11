import io
import multiprocessing
import queue
import threading
from typing import Literal

import pandas as pd
from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from services import forecasters
from services.model_store import (DATASET_DIR, NASA_DATASET, clear_manifest, read_manifest,
                                  service_dir, training_key, write_manifest)
from services.splitter import daily_share_series, load_source, split

router = APIRouter()

SPLIT_SEED = 42
# Training runs in its own process so a cancel can stop it outright, TensorFlow included;
# tests turn this off to train in a thread, where their fakes are patched in.
RUN_IN_SUBPROCESS = True
POLL_SECONDS = 0.5
STOP_GRACE_SECONDS = 5


# ─────────────────────────────────────────────
# 1. 上傳資料集：存檔，本輪尚未被訓練流程使用
# ─────────────────────────────────────────────

@router.post("/uploadDataset")
async def upload_dataset(file: UploadFile = File(...)):
    if not (file.filename.endswith(".csv") or file.filename.endswith(".json")):
        raise HTTPException(status_code=400, detail="Only .csv or .json files are accepted.")

    content = await file.read()
    try:
        raw_df = _read_dataframe(content, file.filename)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=f"Invalid dataset format: {e}")
    if raw_df.empty:
        raise HTTPException(status_code=422, detail="Invalid dataset format: no rows.")

    # 一律存成 CSV；/train 目前固定使用 NASA 資料集，自訂訓練集留待之後接上。
    save_path = DATASET_DIR / "dataset.csv"
    save_path.write_text(raw_df.to_csv(index=False), encoding="utf-8")
    print(f"[Train] Dataset saved to {save_path}")
    return {"message": "Dataset uploaded. Custom training datasets are not used yet; "
                       "models are trained on the built-in NASA1995 dataset."}


def _read_dataframe(content: bytes, filename: str) -> pd.DataFrame:
    if filename.endswith(".json"):
        return pd.read_json(io.BytesIO(content))
    return pd.read_csv(io.BytesIO(content))


# ─────────────────────────────────────────────
# 2. 模擬開始時觸發訓練（Backend 呼叫）
# ─────────────────────────────────────────────

class ServiceSpec(BaseModel):
    service: str = Field(min_length=1)
    dailyRequestCount: float = Field(gt=0)
    model: Literal["arima", "bilstm", "gru"]


class TrainRequest(BaseModel):
    services: list[ServiceSpec] = Field(min_length=1)


class _Job:
    """The one training run allowed at a time, and what /train/progress reports of it."""

    def __init__(self):
        self.lock = threading.Lock()
        self.state = threading.Lock()   # guards the fields below
        self.worker = None
        self.cancelled = False
        self.progress: dict = {}

    def report(self, **progress):
        with self.state:
            self.progress = {**self.progress, **progress}

    def snapshot(self) -> dict:
        with self.state:
            return {"running": self.worker is not None, **self.progress}


_job = _Job()


class TrainingFailed(Exception):
    """Some services' models could not be trained; the message names them."""


def _train_all(specs: list[dict], report) -> dict:
    """Splits the NASA traffic over the services and trains each one's models."""
    source = load_source(NASA_DATASET)
    result = split(source, [s["dailyRequestCount"] for s in specs], seed=SPLIT_SEED)

    results, failed = {}, {}
    for m, spec in enumerate(specs):
        report(done=m, service=spec["service"], model=spec["model"], step=None)
        series = daily_share_series(source.bin_start, source.valid, result.counts[:, m],
                                    source.bins_per_day)
        try:
            results[spec["service"]] = forecasters.train(
                spec["model"], series, service_dir(spec["service"]),
                on_step=lambda step: report(step=step))
        except Exception as e:
            failed[spec["service"]] = f"{type(e).__name__}: {e}"
    report(done=len(specs), step=None)

    if failed:
        raise TrainingFailed(f"Training failed for {failed}")
    return {"splitMethod": "assign" if result.method == 1 else "mix",
            "alpha": result.alpha, "results": results}


def _train_worker(specs: list[dict], events) -> None:
    def report(**progress):
        events.put({"type": "progress", **progress})
    try:
        events.put({"type": "done", "summary": _train_all(specs, report)})
    except Exception as e:
        detail = str(e) if isinstance(e, TrainingFailed) else f"{type(e).__name__}: {e}"
        events.put({"type": "failed", "detail": detail})


def _run(specs: list[dict]) -> dict:
    """Runs _train_worker and relays its progress until it ends; raises if it fails or
    is cancelled."""
    if RUN_IN_SUBPROCESS:
        # spawn, not fork: a fork would copy this process's TensorFlow state.
        context = multiprocessing.get_context("spawn")
        events = context.Queue()
        worker = context.Process(target=_train_worker, args=(specs, events), daemon=True)
    else:
        events = queue.Queue()
        worker = threading.Thread(target=_train_worker, args=(specs, events), daemon=True)
    with _job.state:
        _job.worker, _job.cancelled = worker, False
        _job.progress = {"done": 0, "total": len(specs), "service": None, "model": None, "step": None}
    worker.start()

    outcome = None
    while outcome is None:
        try:
            event = events.get(timeout=POLL_SECONDS)
        except queue.Empty:
            if not worker.is_alive():
                break
            continue
        if event["type"] == "progress":
            _job.report(**{k: v for k, v in event.items() if k != "type"})
        else:
            outcome = event
    worker.join(STOP_GRACE_SECONDS)

    if _job.cancelled:
        raise HTTPException(status_code=409, detail="Training was cancelled.")
    if outcome is None:
        code = getattr(worker, "exitcode", None)
        # -9 is SIGKILL, which the OOM killer sends.
        hint = " It was killed, most likely for running out of memory." if code == -9 else ""
        raise HTTPException(status_code=500, detail=f"Training process exited unexpectedly (exit code {code}).{hint}")
    if outcome["type"] == "failed":
        raise HTTPException(status_code=500, detail=outcome["detail"])
    return outcome["summary"]


@router.post("/train")
def train(req: TrainRequest):
    # The split depends on input order (Dirichlet rows, ties between equal volumes), so
    # order by volume first: renaming a service then only matters when volumes tie.
    services = sorted(req.services, key=lambda s: (-s.dailyRequestCount, s.service))
    names = [s.service for s in services]
    if len(set(names)) != len(names):
        raise HTTPException(status_code=422, detail="Duplicate service in training request.")

    if not _job.lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="Another training run is in progress.")
    try:
        specs = [s.model_dump() for s in services]
        key = training_key(specs)
        manifest = read_manifest()
        if manifest.get("key") == key and all(
                forecasters.is_trained(s.model, service_dir(s.service)) for s in services):
            return {**manifest["summary"], "cached": True}

        # Model directories are per service name, so retraining overwrites them in place.
        # Drop the old key first, or a run that fails or is cancelled halfway would leave
        # it looking valid over a mix of old and new models.
        clear_manifest()
        summary = _run(specs)
        write_manifest({"key": key, "summary": summary})
        print(f"[Train] {len(services)} service model(s) trained ({summary['splitMethod']} split)")
        return {**summary, "cached": False}
    finally:
        with _job.state:
            _job.worker, _job.progress = None, {}
        _job.lock.release()


@router.get("/train/progress")
def train_progress():
    """{running, done, total, service, model, step}: `done` services of `total` are
    trained, and `step` (one of forecasters.TRAINING_STEPS) of `service` is under way."""
    return _job.snapshot()


@router.post("/train/cancel")
def cancel_training():
    with _job.state:
        worker = _job.worker
        if worker is None:
            return {"cancelled": False}
        _job.cancelled = True
    if isinstance(worker, multiprocessing.process.BaseProcess):
        worker.terminate()
        worker.join(STOP_GRACE_SECONDS)
        if worker.is_alive():
            worker.kill()
    print("[Train] Training cancelled")
    return {"cancelled": True}
