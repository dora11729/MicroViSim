import axios from "axios";
import { multiStepForecasts } from "../../entities/TSimConfigLoadSimulation";
import {
  ISimulationProgress,
  NoProgress,
  SimulationCancelledError,
  SimulationFailedError,
  TTrainingProgress,
} from "../../entities/TSimulationProgress";

const PROGRESS_POLL_MS = 2000;
const LEFTOVER_STOP_TIMEOUT_MS = 30_000;
const LEFTOVER_POLL_MS = 500;

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
    one-minute models can take well over the 5 minutes fetch waits for a response. Relays
    the ML service's progress while it trains, and cancels its training if the run is
    cancelled.
  */
  async train(services: TMLTrainingService[], progress: ISimulationProgress = NoProgress): Promise<void> {
    const cancelTraining = () => {
      axios.post(`${this.baseUrl}/train/cancel`).catch(e =>
        console.error("[MLModelClient] could not cancel training:", e instanceof Error ? e.message : e));
    };
    progress.signal.addEventListener("abort", cancelTraining);
    const poller = setInterval(() => this.relayTrainingProgress(progress), PROGRESS_POLL_MS);

    const requestTraining = async (): Promise<{ splitMethod: string; cached: boolean }> =>
      (await axios.post(`${this.baseUrl}/train`, { services }, { timeout: 0, signal: progress.signal })).data;
    const failure = (e: unknown) => progress.signal.aborted
      ? new SimulationCancelledError()
      : new SimulationFailedError(`Model training failed: ${this.describeError(e)}`);

    let body: { splitMethod: string; cached: boolean };
    try {
      body = await requestTraining();
    } catch (e) {
      if (progress.signal.aborted || !this.isLeftoverTraining(e)) throw failure(e);
      // One simulation runs at a time, so a training run the ML service is still busy
      // with was left behind by an interrupted one: a backend restart or a lost cancel.
      progress.warn("Stopped a model training run left over from an earlier, interrupted simulation.");
      await this.stopLeftoverTraining(progress);
      try {
        body = await requestTraining();
      } catch (retryError) {
        throw failure(retryError);
      }
    } finally {
      clearInterval(poller);
      progress.signal.removeEventListener("abort", cancelTraining);
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
    multiSteps: readonly TMultiStepForecast[],
    signal?: AbortSignal
  ): Promise<Record<TMultiStepForecast, (number | null)[]> | null> {
    try {
      const res = await fetch(`${this.baseUrl}/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service, model, shares, multiSteps }),
        signal,
      });
      if (!res.ok) {
        console.error(`[MLModelClient] predict failed: ${model} for ${service} returned HTTP ${res.status}`);
        return null;
      }
      return ((await res.json()) as { predictions: Record<TMultiStepForecast, (number | null)[]> }).predictions;
    } catch (e) {
      if (signal?.aborted) throw new SimulationCancelledError();
      console.error("[MLModelClient] predict failed:", e);
      return null;
    }
  }

  private async relayTrainingProgress(progress: ISimulationProgress) {
    try {
      const { data } = await axios.get<TTrainingProgress & { running: boolean }>(
        `${this.baseUrl}/train/progress`, { timeout: PROGRESS_POLL_MS }
      );
      if (data.running && !progress.signal.aborted) {
        const { running, ...training } = data;
        progress.training(training);
      }
    } catch {
      // Progress is only shown, never relied on; the next poll may get through.
    }
  }

  private isLeftoverTraining(e: unknown): boolean {
    return axios.isAxiosError(e) && e.response?.status === 409 &&
      String(e.response.data?.detail ?? "").startsWith("Another training run");
  }

  // Cancels it and waits until the ML service is free, or gives up after a while.
  private async stopLeftoverTraining(progress: ISimulationProgress) {
    await axios.post(`${this.baseUrl}/train/cancel`);
    const deadline = Date.now() + LEFTOVER_STOP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, LEFTOVER_POLL_MS));
      progress.throwIfCancelled();
      const { data } = await axios.get<{ running: boolean }>(`${this.baseUrl}/train/progress`);
      // The run reports itself stopped just before it frees the ML service; give it a beat.
      if (!data.running) return new Promise(resolve => setTimeout(resolve, LEFTOVER_POLL_MS));
    }
  }

  // The ML service's own reason when it gave one, else why it could not be reached.
  private describeError(e: unknown): string {
    if (!axios.isAxiosError(e)) return e instanceof Error ? e.message : String(e);
    if (e.response) return `HTTP ${e.response.status}: ${e.response.data?.detail ?? e.message}`;
    return `cannot reach the ML service at ${this.baseUrl} (${e.code ?? e.message})`;
  }
}
