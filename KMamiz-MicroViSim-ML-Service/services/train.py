import io
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


@router.post("/train")
def train(req: TrainRequest):
    # The split depends on input order (Dirichlet rows, ties between equal volumes), so
    # order by volume first: renaming a service then only matters when volumes tie.
    services = sorted(req.services, key=lambda s: (-s.dailyRequestCount, s.service))
    names = [s.service for s in services]
    if len(set(names)) != len(names):
        raise HTTPException(status_code=422, detail="Duplicate service in training request.")

    specs = [s.model_dump() for s in services]
    key = training_key(specs)
    manifest = read_manifest()
    if manifest.get("key") == key and all(
            forecasters.is_trained(s.model, service_dir(s.service)) for s in services):
        return {**manifest["summary"], "cached": True}

    # Model directories are per service name, so retraining overwrites them in place.
    # Drop the old key first, or a run that fails halfway would leave it looking valid
    # over a mix of old and new models.
    clear_manifest()

    source = load_source(NASA_DATASET)
    result = split(source, [s.dailyRequestCount for s in services], seed=SPLIT_SEED)

    results, failed = {}, {}
    for m, spec in enumerate(services):
        series = daily_share_series(source.bin_start, source.valid, result.counts[:, m])
        try:
            meta = forecasters.train(spec.model, series, service_dir(spec.service))
            results[spec.service] = meta
        except Exception as e:
            failed[spec.service] = f"{type(e).__name__}: {e}"

    if failed:
        raise HTTPException(status_code=500, detail=f"Training failed for {failed}")

    summary = {"splitMethod": "assign" if result.method == 1 else "mix",
               "alpha": result.alpha, "results": results}
    write_manifest({"key": key, "summary": summary})
    print(f"[Train] {len(services)} service model(s) trained ({summary['splitMethod']} split)")
    return {**summary, "cached": False}
