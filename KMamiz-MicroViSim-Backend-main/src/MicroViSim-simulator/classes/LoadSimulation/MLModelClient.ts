export type MLModelType = "arima" | "bilstm" | "gru";

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

  // Throws on failure: without trained models there is nothing to scale by.
  async train(services: TMLTrainingService[]): Promise<void> {
    const res = await fetch(`${this.baseUrl}/train`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ services }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`ML training failed (HTTP ${res.status}): ${body.detail ?? "no detail"}`);
    }
    const body = await res.json();
    console.log(
      `[MLModelClient] ${services.length} model(s) ready ` +
      `(${body.splitMethod} split${body.cached ? ", cached" : ""})`
    );
  }

  /*
    One-step predictions of the percent-of-day share for every slot. predictions[t]
    is computed from shares[0..t-1] only; null where history is too short. Returns
    null when the ML service fails, so the caller can fall back for the whole run.
  */
  async predictShares(
    service: string,
    model: MLModelType,
    shares: number[]
  ): Promise<(number | null)[] | null> {
    try {
      const res = await fetch(`${this.baseUrl}/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service, model, shares }),
      });
      if (!res.ok) {
        console.error(`[MLModelClient] predict failed: ${model} for ${service} returned HTTP ${res.status}`);
        return null;
      }
      return ((await res.json()) as { predictions: (number | null)[] }).predictions;
    } catch (e) {
      console.error("[MLModelClient] predict failed:", e);
      return null;
    }
  }
}
