// Mirrors the backend's SimulationJob status (GET /simulation/status).

export type TSimulationStage =
  | "validating"
  | "simulatingTraffic"
  | "trainingModels"
  | "simulatingLoadEffects"
  | "generatingMetrics"
  | "saving";

export type TSimulationJobState = "idle" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
export type TStageStatus = "pending" | "active" | "done" | "skipped" | "failed" | "cancelled";

export type TTrainingProgress = {
  done: number;           // services fully trained
  total: number;
  service: string | null; // uniqueServiceName under training
  model: string | null;
  step: string | null;    // one of TrainingSteps
};

export type TSimulationJobStatus = {
  state: TSimulationJobState;
  stages: { stage: TSimulationStage; status: TStageStatus }[];
  detail: string | null;
  training: TTrainingProgress | null;
  warnings: string[];
  error: string | null;   // "\n---\n" separates its parts
  startedAt: number | null;
  finishedAt: number | null;
  cancellable: boolean;
};

// The ML service's training steps for each service, in order.
export const TrainingSteps = ["one-minute model", "rectify kNN", "direct models", "hourly model"];

export const isRunning = (status?: TSimulationJobStatus | null) =>
  status?.state === "running" || status?.state === "cancelling";
