import axios from "axios";
import { multiStepForecasts } from "../../entities/TSimConfigLoadSimulation";

export type MLModelType = "arima" | "bilstm" | "gru";
export type TMultiStepForecast = typeof multiStepForecasts[number];

export type TMLTrainingService = {
  service: string;            // uniqueServiceName
  dailyRequestCount: number;  // total external daily requests of the service
  model: MLModelType;
};

export default class MLModelClient {
  private static instance?: MLModelClient;
  static getInstance = () => this.instance || (this.instance = new this());

  private readonly baseUrl: string;

  private constructor() {
    this.baseUrl = process.env.ML_SERVICE_URL ?? "http://localhost:8000";
  }

  /*
    Throws on failure: without trained models there is nothing to scale by. No timeout:
    one-minute models can take well over the 5 minutes fetch waits for a response.
  */
  async train(services: TMLTrainingService[]): Promise<void> {
    let body: { splitMethod: string; cached: boolean };
    try {
      body = (await axios.post(`${this.baseUrl}/train`, { services }, { timeout: 0 })).data;
    } catch (e) {
      const status = axios.isAxiosError(e) ? e.response?.status ?? "no response" : "no response";
      const detail = axios.isAxiosError(e) ? e.response?.data?.detail ?? e.message : String(e);
      throw new Error(`ML training failed (HTTP ${status}): ${detail}`);
    }
    console.log(
      `[MLModelClient] ${services.length} model(s) ready ` +
      `(${body.splitMethod} split${body.cached ? ", cached" : ""})`
    );
  }

  /*
    Next-hour percent-of-day share for every hour, by each strategy. predictions[t] is
    computed from shares[0..t-1] only; null where history is too short. Returns null when
    the ML service fails, so the caller can fall back for the whole run.
  */
  async predictShares(
    service: string,
    model: MLModelType,
    shares: number[],
    multiSteps: readonly TMultiStepForecast[]
  ): Promise<Record<TMultiStepForecast, (number | null)[]> | null> {
    try {
      const res = await fetch(`${this.baseUrl}/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service, model, shares, multiSteps }),
      });
      if (!res.ok) {
        console.error(`[MLModelClient] predict failed: ${model} for ${service} returned HTTP ${res.status}`);
        return null;
      }
      return ((await res.json()) as { predictions: Record<TMultiStepForecast, (number | null)[]> }).predictions;
    } catch (e) {
      console.error("[MLModelClient] predict failed:", e);
      return null;
    }
  }
}
