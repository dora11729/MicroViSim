// src/simulator/load/MLModelClient.ts

export type MLModelType = "xgboost" | "random_forest" | "lstm";

export interface MLPredictFeatures {
  replicaCount: number;
  requestCountPerSecond: number;
  replicaMaxRPS: number;
  service: number;  // 訓練時 1~4，模擬預測時傳 0
}

// LSTM 專用：過去 10 個時間步的 features
export type MLPredictSequence = MLPredictFeatures[];

export default class MLModelClient {
  private static instance?: MLModelClient;
  static getInstance = () => this.instance || (this.instance = new this());

  private readonly baseUrl: string;

  private constructor() {
    this.baseUrl = process.env.ML_SERVICE_URL ?? "http://localhost:8000";
  }

  async predictNextRequestCount(
    model: MLModelType,
    featuresOrSequence: MLPredictFeatures | MLPredictSequence
  ): Promise<number | null> {
    const body =
      model === "lstm"
        ? { model, sequence: featuresOrSequence }
        : { model, features: featuresOrSequence };

    try {
      const res = await fetch(`${this.baseUrl}/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        predicted_request_count_per_second: number;
      };
      return data.predicted_request_count_per_second;
    } catch (e) {
      console.error("[MLModelClient] predict failed:", e);
      return null;
    }
  }
}