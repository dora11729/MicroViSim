from fastapi import FastAPI
from contextlib import asynccontextmanager
from services.predict import router as predict_router
from services.model_loader import load_all_models
from dotenv import load_dotenv
import os

load_dotenv()

@asynccontextmanager
async def lifespan(app: FastAPI):
    # 啟動時載入模型
    load_all_models()
    yield
    # 關閉時清理（如有需要）

app = FastAPI(
    title="MicroViSim ML Sidecar",
    version="1.0.0",
    lifespan=lifespan
)

app.include_router(predict_router)