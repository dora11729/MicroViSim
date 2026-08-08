from fastapi import APIRouter, HTTPException, UploadFile, File
from pydantic import BaseModel
import pandas as pd
import numpy as np
import joblib
import io
from pathlib import Path
from services.model_loader import FINETUNE_DIR, DATASET_DIR, load_all_models

router = APIRouter()

FEATURE_COLS = ["replicaCount", "requestCountPerSecond", "replicaMaxRPS", "service"]
TARGET_COL   = "target_next"


# ─────────────────────────────────────────────
# 1. 上傳資料集：正規化成 CSV 後存檔，不訓練
# ─────────────────────────────────────────────

@router.post("/uploadDataset")
async def upload_dataset(file: UploadFile = File(...)):
    if not (file.filename.endswith(".csv") or file.filename.endswith(".json")):
        raise HTTPException(status_code=400, detail="Only .csv or .json files are accepted.")

    content = await file.read()
    save_path = DATASET_DIR / "dataset.csv"

    # 先驗證格式是否正確
    try:
        raw_df = _read_dataframe(content, file.filename)
        _prepare_dataframe(raw_df)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=f"Invalid dataset format: {e}")

    # 一律存成 CSV（覆蓋舊的），否則 /train 讀回來時無從得知原始格式。
    # 存的是未經前處理的原始欄位，讓 /train 能重跑完整的 _prepare_dataframe。
    save_path.write_text(raw_df.to_csv(index=False), encoding="utf-8")
    print(f"[Train] Dataset saved to {save_path}")

    return {"message": "Dataset uploaded successfully. It will be used for training when simulation starts."}


# ─────────────────────────────────────────────
# 2. 模擬開始時觸發訓練（Backend 呼叫）
# ─────────────────────────────────────────────

class TrainRequest(BaseModel):
    models: list[str]  # e.g. ["xgboost", "lstm"]

@router.post("/train")
async def train(req: TrainRequest):
    dataset_path = DATASET_DIR / "dataset.csv"
    if not dataset_path.exists():
        raise HTTPException(
            status_code=404,
            detail="No dataset found. Please upload a training dataset first."
        )

    content = dataset_path.read_bytes()
    try:
        df = _prepare_dataframe(_read_dataframe(content, "dataset.csv"))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    X = df[FEATURE_COLS]
    y = df[TARGET_COL]
    results = {}

    for model_name in req.models:
        if model_name == "xgboost":
            results["xgboost"] = _train_xgboost(X, y)
        elif model_name == "random_forest":
            results["random_forest"] = _train_random_forest(X, y)
        elif model_name == "lstm":
            results["lstm"] = _train_lstm(df, FEATURE_COLS)
        else:
            results[model_name] = f"unknown model"

    # 訓練完 reload
    load_all_models()

    failed = {k: v for k, v in results.items() if v != "ok"}
    if failed:
        raise HTTPException(status_code=500, detail=f"Some models failed: {failed}")

    return {"message": "Training completed.", "results": results}


# ─────────────────────────────────────────────
# 前處理（跟訓練時一致）
# ─────────────────────────────────────────────

def _read_dataframe(content: bytes, filename: str) -> pd.DataFrame:
    if filename.endswith(".json"):
        return pd.read_json(io.BytesIO(content))
    return pd.read_csv(io.BytesIO(content))


def _prepare_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()  # 呼叫端還要用原始 DataFrame 存檔

    required = {"requestCountPerSecond", "replicaCount", "replicaMaxRPS", "service", "timeSlotKey"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"Missing columns: {missing}")

    valid_services = df.groupby("service")["requestCountPerSecond"].sum()
    valid_services = valid_services[valid_services > 0].index
    df = df[df["service"].isin(valid_services)]

    df[["day", "hour", "minute"]] = df["timeSlotKey"].str.split("-", expand=True).astype(int)
    df["timestamp"] = df["day"] * 24 * 60 + df["hour"] * 60 + df["minute"]
    df = df.sort_values(["timestamp", "service"]).reset_index(drop=True)

    df["target_next"] = df.groupby("service")["requestCountPerSecond"].shift(-1)
    df = df.dropna()
    df["service"] = df["service"].astype("category").cat.codes + 1

    return df


# ─────────────────────────────────────────────
# 各模型訓練
# ─────────────────────────────────────────────

def _train_xgboost(X, y) -> str:
    try:
        import xgboost as xgb
        model = xgb.XGBRegressor(
            objective="reg:squarederror", n_estimators=300, max_depth=4,
            learning_rate=0.06, subsample=0.8, colsample_bytree=0.7, random_state=42
        )
        model.fit(X, y)
        model.save_model(str(FINETUNE_DIR / "xgb_model.json"))
        return "ok"
    except Exception as e:
        return f"failed: {e}"

def _train_random_forest(X, y) -> str:
    try:
        from sklearn.ensemble import RandomForestRegressor
        rf = RandomForestRegressor(n_estimators=300, max_depth=10, random_state=42, n_jobs=-1)
        rf.fit(X, y)
        joblib.dump(rf, FINETUNE_DIR / "random_forest_model.joblib")
        return "ok"
    except Exception as e:
        return f"failed: {e}"

def _train_lstm(df: pd.DataFrame, feature_cols: list) -> str:
    try:
        from sklearn.preprocessing import StandardScaler
        from tensorflow.keras.models import Sequential
        from tensorflow.keras.layers import LSTM, Dense
        from tensorflow.keras.callbacks import EarlyStopping

        window_size = 10

        def build_sequences(dataframe):
            X_all, y_all = [], []
            for svc_code in dataframe["service"].unique():
                svc_df = dataframe[dataframe["service"] == svc_code].sort_values("timestamp")
                X_vals = svc_df[feature_cols].values
                y_vals = svc_df[TARGET_COL].values
                if len(X_vals) <= window_size:
                    continue
                for i in range(len(X_vals) - window_size + 1):
                    X_all.append(X_vals[i:i+window_size])
                    y_all.append(y_vals[i+window_size-1])
            return (np.array(X_all), np.array(y_all)) if X_all else (None, None)

        # Trains on the whole dataset, like xgboost and random_forest do. Held-out
        # evaluation is a separate simulation run, not a slice of this timeline.
        X_train, y_train = build_sequences(df)
        if X_train is None:
            return "failed: not enough data"

        scaler = StandardScaler()
        n, t, f = X_train.shape
        X_scaled = scaler.fit_transform(X_train.reshape(-1, f)).reshape(n, t, f)
        # Only used to stop training before it overfits, not as a test set.
        val_split = int(len(X_scaled) * 0.8)

        model = Sequential([
            LSTM(64, input_shape=(window_size, len(feature_cols))),
            Dense(32, activation="relu"),
            Dense(1)
        ])
        model.compile(optimizer="adam", loss="mse")
        model.fit(
            X_scaled[:val_split], y_train[:val_split],
            validation_data=(X_scaled[val_split:], y_train[val_split:]),
            epochs=50, batch_size=64,
            callbacks=[EarlyStopping(monitor="val_loss", patience=5, restore_best_weights=True)],
            verbose=0
        )
        model.save(str(FINETUNE_DIR / "lstm_model.keras"))
        joblib.dump(
            {"scaler": scaler, "features": feature_cols, "window_size": window_size},
            FINETUNE_DIR / "lstm_preprocess.pkl"
        )
        return "ok"
    except Exception as e:
        return f"failed: {e}"