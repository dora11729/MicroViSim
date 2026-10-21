from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI

from services.model_store import clear_trained_models
from services.predict import router as predict_router
from services.train import router as train_router

load_dotenv()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Models are trained per service on demand and loaded per request, so nothing is
    # preloaded; the previous container's models are discarded instead.
    clear_trained_models()
    yield


app = FastAPI(
    title="MicroViSim ML Sidecar",
    version="2.0.0",
    lifespan=lifespan,
)

app.include_router(predict_router)
app.include_router(train_router)
