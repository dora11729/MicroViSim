from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services import forecasters
from services.model_store import read_manifest, service_dir

router = APIRouter()


class PredictRequest(BaseModel):
    service: str
    model: Literal["arima", "bilstm", "gru"]
    # Observed percent-of-day share for every hour of the simulation, in order.
    shares: list[float]
    # What the one-minute model is fed for minutes 2..60 of the hour it forecasts.
    multiStep: Literal["recursive", "linearInput"] = "recursive"


class PredictResponse(BaseModel):
    # predictions[t] is built from shares[0..t-1] only; None for hour 0.
    predictions: list[float | None]


@router.get("/health")
def health():
    trained = list(read_manifest().get("summary", {}).get("results", {}))
    return {"status": "ok", "trainedServices": trained}


@router.post("/predict", response_model=PredictResponse)
def predict(req: PredictRequest):
    directory = service_dir(req.service)
    if not forecasters.is_trained(req.model, directory):
        raise HTTPException(status_code=404,
                            detail=f"No trained {req.model} model for service '{req.service}'.")
    try:
        predictions = forecasters.predict(req.model, directory, req.shares, req.multiStep)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")
    return PredictResponse(predictions=predictions)
