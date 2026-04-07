from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from services.model_loader import get_model, available_models
import numpy as np

router = APIRouter()

# ─────────────────────────────────────────────
# Schema
# ─────────────────────────────────────────────

class PredictRequest(BaseModel):
    model: str
    features: dict | None = None        # XGBoost / RandomForest
    sequence: list[dict] | None = None  # LSTM

class PredictResponse(BaseModel):
    predicted_request_count_per_second: float
    model_used: str

# 訓練時的 feature 欄位順序（XGBoost / RandomForest 共用）
TABULAR_FEATURE_ORDER = [
    "replicaCount",
    "requestCountPerSecond",
    "replicaMaxRPS",
    "service",  # 訓練時 1~n，模擬預測時傳 0
]

# ─────────────────────────────────────────────
# Endpoints
# ─────────────────────────────────────────────

@router.get("/health")
def health():
    return {"status": "ok", "available_models": available_models()}


@router.post("/predict", response_model=PredictResponse)
def predict(req: PredictRequest):
    if req.model not in available_models():
        raise HTTPException(
            status_code=404,
            detail=f"Model '{req.model}' not available. Available: {available_models()}"
        )

    if req.model in ("xgboost", "random_forest"):
        result = _predict_tabular(req.model, req.features)
    elif req.model == "lstm":
        result = _predict_lstm(req.sequence)
    else:
        raise HTTPException(status_code=400, detail="Unknown model.")

    result = max(0.0, result)
    return PredictResponse(
        predicted_request_count_per_second=result,
        model_used=req.model
    )

# ─────────────────────────────────────────────
# XGBoost / RandomForest
# ─────────────────────────────────────────────

def _predict_tabular(model_name: str, features: dict | None) -> float:
    if features is None:
        raise HTTPException(
            status_code=422,
            detail="'features' is required for xgboost/random_forest."
        )

    model = get_model(model_name)

    # 兩個模型都用同一組固定欄位順序，缺的補 0
    vector = [float(features.get(f, 0)) for f in TABULAR_FEATURE_ORDER]
    X = np.array([vector])

    return float(model.predict(X)[0])

# ─────────────────────────────────────────────
# LSTM
# ─────────────────────────────────────────────

def _predict_lstm(sequence: list[dict] | None) -> float:
    if sequence is None:
        raise HTTPException(
            status_code=422,
            detail="'sequence' is required for lstm."
        )

    preproc    = get_model("lstm_preproc")
    lstm_model = get_model("lstm_model")

    scaler      = preproc["scaler"]       # StandardScaler
    features    = preproc["features"]     # 訓練時的欄位順序: ["replicaCount", "requestCountPerSecond", "replicaMaxRPS", "service"]
    window_size = preproc["window_size"]  # 10

    if len(sequence) != window_size:
        raise HTTPException(
            status_code=422,
            detail=f"'sequence' must have exactly {window_size} time steps, got {len(sequence)}."
        )

    try:
        X = np.array([
            [float(step.get(f, 0)) for f in features]
            for step in sequence
        ])  # shape: (window_size, n_features)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Failed to parse sequence: {e}")

    # scaler 是用 (samples * timesteps, n_features) fit 的
    X_scaled = scaler.transform(X)                               # (window_size, n_features)
    X_input  = X_scaled.reshape(1, window_size, len(features))  # (1, 10, n_features)

    result = lstm_model.predict(X_input, verbose=0)
    return float(result[0][0])