// The stages of one simulation run, in order; trainingModels is skipped when no service
// names a model.
export const simulationStages = [
  "validating",             // clear old data, check and convert the YAML
  "simulatingTraffic",      // generate traffic, inject faults, first propagation
  "trainingModels",         // ML /train
  "simulatingLoadEffects",  // scale replicas (forecasting load if models are used), overload, second propagation
  "generatingMetrics",      // turn the results into the Metrics page's data
  "saving",                 // write the results; no longer cancellable
] as const;
export type TSimulationStage = typeof simulationStages[number];

// Mirrors the ML service's /train/progress: `done` of `total` services are trained and
// `step` of `service` is under way.
export type TTrainingProgress = {
  done: number;
  total: number;
  service: string | null;
  model: string | null;
  step: string | null;
};

// What a run reports through, and is cancelled by, as it goes.
export interface ISimulationProgress {
  readonly signal: AbortSignal;
  // Throws SimulationCancelledError if the run was cancelled.
  stage(stage: TSimulationStage, detail?: string): void;
  training(progress: TTrainingProgress): void;
  // Something went wrong that the run works around, e.g. a model falling back to naive.
  warn(message: string): void;
  throwIfCancelled(): void;
}

export class SimulationCancelledError extends Error {
  constructor() {
    super("Simulation was cancelled.");
  }
}

// A failure meant for the user as is, e.g. invalid YAML or a failed training run.
export class SimulationFailedError extends Error {}

// For callers that run a simulation outside a job, such as tests.
export const NoProgress: ISimulationProgress = {
  signal: new AbortController().signal,
  stage: () => undefined,
  training: () => undefined,
  warn: () => undefined,
  throwIfCancelled: () => undefined,
};
