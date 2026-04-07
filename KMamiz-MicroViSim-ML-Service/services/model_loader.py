import joblib
import numpy as np
from pathlib import Path
import tensorflow as tf

MODEL_DIR = Path(__file__).parent.parent / "models"

_models = {}

def load_all_models():
    # XGBoost
    xgb_path = MODEL_DIR / "xgb_model.json"
    if xgb_path.exists():
        import xgboost as xgb
        m = xgb.XGBRegressor()
        m.load_model(str(xgb_path))
        _models["xgboost"] = m
        print("[ModelLoader] ✅ Loaded: xgboost")
    else:
        print("[ModelLoader] ⚠️  Not found: xgb_model.json")

    # RandomForest
    rf_path = MODEL_DIR / "random_forest_model.joblib"
    if rf_path.exists():
        _models["random_forest"] = joblib.load(rf_path)
        print("[ModelLoader] ✅ Loaded: random_forest")
    else:
        print("[ModelLoader] ⚠️  Not found: random_forest_model.joblib")

    # LSTM + preprocessor
    lstm_path   = MODEL_DIR / "lstm_model.keras"
    preproc_path = MODEL_DIR / "lstm_preprocess.pkl"
    if lstm_path.exists() and preproc_path.exists():
        _models["lstm_model"]   = tf.keras.models.load_model(str(lstm_path))
        _models["lstm_preproc"] = joblib.load(preproc_path)
        # lstm_preproc 包含: { scaler, features, window_size }
        print("[ModelLoader] ✅ Loaded: lstm")
    else:
        print("[ModelLoader] ⚠️  Not found: lstm_model.keras or lstm_preprocess.pkl")

def get_model(name: str):
    if name not in _models:
        raise ValueError(f"Model '{name}' not loaded.")
    return _models[name]

def available_models() -> list[str]:
    # 對外公開的模型名稱
    result = []
    if "xgboost"       in _models: result.append("xgboost")
    if "random_forest" in _models: result.append("random_forest")
    if "lstm_model"    in _models: result.append("lstm")
    return result