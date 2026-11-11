import {
  ISimulationProgress,
  SimulationCancelledError,
  simulationStages,
  TSimulationStage,
  TTrainingProgress,
} from "../entities/TSimulationProgress";

export type TSimulationJobState = "idle" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
export type TStageStatus = "pending" | "active" | "done" | "skipped" | "failed" | "cancelled";

export type TSimulationJobStatus = {
  state: TSimulationJobState;
  stages: { stage: TSimulationStage; status: TStageStatus }[];
  detail: string | null;                 // what the active stage is doing
  training: TTrainingProgress | null;    // while models train
  warnings: string[];
  error: string | null;                  // when failed; "\n---\n" separates its parts
  startedAt: number | null;              // epoch ms
  finishedAt: number | null;
  cancellable: boolean;
};

class SimulationJob implements ISimulationProgress {
  private controller = new AbortController();
  private stages = simulationStages.map(stage => ({ stage, status: "pending" as TStageStatus }));
  private detail: string | null = null;
  private trainingProgress: TTrainingProgress | null = null;
  private warnings: string[] = [];
  private state: TSimulationJobState = "running";
  private error: string | null = null;
  private readonly startedAt = Date.now();
  private finishedAt: number | null = null;

  get signal() {
    return this.controller.signal;
  }

  get running() {
    return this.state === "running" || this.state === "cancelling";
  }

  stage(stage: TSimulationStage, detail?: string) {
    this.throwIfCancelled();
    const index = simulationStages.indexOf(stage);
    this.stages.forEach((s, i) => {
      if (i < index) s.status = s.status === "pending" ? "skipped" : s.status === "active" ? "done" : s.status;
    });
    this.stages[index].status = "active";
    this.detail = detail ?? null;
    this.trainingProgress = null;
  }

  // Polled progress can land after training ended; it no longer describes the run then.
  training(progress: TTrainingProgress) {
    if (this.activeStage() === "trainingModels") this.trainingProgress = progress;
  }

  warn(message: string) {
    this.warnings.push(message);
  }

  throwIfCancelled() {
    if (this.signal.aborted) throw new SimulationCancelledError();
  }

  // Saving writes the results piece by piece; stopping it would leave half a run behind.
  get cancellable() {
    return this.state === "running" && this.activeStage() !== "saving";
  }

  cancel() {
    this.state = "cancelling";
    this.controller.abort();
  }

  finish(outcome: {} | { error: unknown }) {
    const error = "error" in outcome ? outcome.error : undefined;
    const active = this.stages.find(s => s.status === "active");
    if (!("error" in outcome)) {
      this.state = "succeeded";
      if (active) active.status = "done";
      this.stages.forEach(s => { if (s.status === "pending") s.status = "skipped"; });
    } else if (error instanceof SimulationCancelledError || this.signal.aborted) {
      this.state = "cancelled";
      if (active) active.status = "cancelled";
    } else {
      this.state = "failed";
      this.error = error instanceof Error ? error.message : String(error);
      if (active) active.status = "failed";
    }
    this.trainingProgress = null;
    this.finishedAt = Date.now();
  }

  status(): TSimulationJobStatus {
    return {
      state: this.state,
      stages: this.stages.map(s => ({ ...s })),
      detail: this.detail,
      training: this.trainingProgress,
      warnings: [...this.warnings],
      error: this.error,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      cancellable: this.cancellable,
    };
  }

  private activeStage() {
    return this.stages.find(s => s.status === "active")?.stage;
  }
}

/*
  Runs one simulation at a time in the background, so the request that starts it returns
  at once and the page follows it through status(); a run that outlived the HTTP request
  used to keep going unseen while the page let the user start another.
*/
export default class SimulationJobManager {
  private static instance?: SimulationJobManager;
  static getInstance = () => this.instance || (this.instance = new this());
  private constructor() { }

  private job: SimulationJob | null = null;

  // False when a run is already going.
  start(run: (progress: ISimulationProgress) => Promise<void>): boolean {
    if (this.job?.running) return false;
    const job = new SimulationJob();
    this.job = job;
    run(job).then(
      () => job.finish({}),
      error => {
        if (!(error instanceof SimulationCancelledError)) console.error("[Simulation] failed:", error);
        job.finish({ error });
      }
    );
    return true;
  }

  cancel(): "cancelling" | "notRunning" | "notCancellable" {
    if (!this.job?.running) return "notRunning";
    if (!this.job.cancellable) return "notCancellable";
    this.job.cancel();
    return "cancelling";
  }

  status(): TSimulationJobStatus {
    return this.job?.status() ?? {
      state: "idle",
      stages: simulationStages.map(stage => ({ stage, status: "pending" })),
      detail: null,
      training: null,
      warnings: [],
      error: null,
      startedAt: null,
      finishedAt: null,
      cancellable: false,
    };
  }
}
