import SimulationJobManager from "../../src/MicroViSim-simulator/classes/SimulationJob";
import {
  ISimulationProgress,
  SimulationFailedError,
} from "../../src/MicroViSim-simulator/entities/TSimulationProgress";

const manager = SimulationJobManager.getInstance();
const unfinished: ((error?: unknown) => void)[] = [];

// A run that waits until the test lets it go on; finish() settles it.
function controllableRun() {
  let release!: (error?: unknown) => void;
  let progress!: ISimulationProgress;
  const gate = new Promise<void>((resolve, reject) => {
    release = error => (error === undefined ? resolve() : reject(error));
  });
  const run = async (p: ISimulationProgress) => {
    progress = p;
    await gate;
  };
  unfinished.push(release);
  return { run, progress: () => progress, finish: release };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

function stageStatuses() {
  return Object.fromEntries(manager.status().stages.map(s => [s.stage, s.status]));
}

describe("SimulationJobManager", () => {
  afterEach(async () => {
    unfinished.splice(0).forEach(release => release());
    await settle();
  });

  it("runs one simulation at a time", async () => {
    const first = controllableRun();
    expect(manager.start(first.run)).toBe(true);
    expect(manager.start(controllableRun().run)).toBe(false);

    first.finish();
    await settle();
    expect(manager.status().state).toBe("succeeded");
    expect(manager.start(controllableRun().run)).toBe(true);
  });

  it("marks stages done, skipped and active as the run moves on", async () => {
    const job = controllableRun();
    manager.start(job.run);
    await settle();
    job.progress().stage("validating");
    job.progress().stage("simulatingLoadEffects", "Scaling replicas");

    expect(stageStatuses()).toEqual({
      validating: "done", simulatingTraffic: "skipped", trainingModels: "skipped",
      simulatingLoadEffects: "active", generatingMetrics: "pending", saving: "pending",
    });
    expect(manager.status().detail).toBe("Scaling replicas");

    job.finish();
    await settle();
    expect(stageStatuses()).toMatchObject({ simulatingLoadEffects: "done", generatingMetrics: "skipped" });
  });

  it("reports the user-facing message of a failed run", async () => {
    const job = controllableRun();
    manager.start(job.run);
    await settle();
    job.progress().stage("trainingModels");

    job.finish(new SimulationFailedError("Model training failed: HTTP 500"));
    await settle();
    expect(manager.status()).toMatchObject({ state: "failed", error: "Model training failed: HTTP 500" });
    expect(stageStatuses().trainingModels).toBe("failed");
  });

  it("cancels a run at its next stage", async () => {
    const job = controllableRun();
    manager.start(job.run);
    await settle();
    job.progress().stage("trainingModels");

    expect(manager.cancel()).toBe("cancelling");
    expect(job.progress().signal.aborted).toBe(true);
    expect(manager.status()).toMatchObject({ state: "cancelling", cancellable: false });
    expect(manager.status().cancelRequestedAt).toEqual(expect.any(Number));
    expect(() => job.progress().stage("simulatingLoadEffects")).toThrow("cancelled");

    job.finish(new Error("aborted"));
    await settle();
    expect(manager.status().state).toBe("cancelled");
    expect(stageStatuses().trainingModels).toBe("cancelled");
  });

  it("refuses to cancel while saving or when idle", async () => {
    const job = controllableRun();
    manager.start(job.run);
    await settle();
    job.progress().stage("saving");
    expect(manager.cancel()).toBe("notCancellable");

    job.finish();
    await settle();
    expect(manager.cancel()).toBe("notRunning");
  });

  it("keeps the warnings and training progress it was given", async () => {
    const job = controllableRun();
    manager.start(job.run);
    await settle();
    job.progress().stage("trainingModels");
    job.progress().training({ done: 1, total: 3, service: "order", model: "gru", step: "rectify kNN" });
    job.progress().warn("Prediction failed for order");

    expect(manager.status()).toMatchObject({
      training: { done: 1, total: 3, step: "rectify kNN" },
      warnings: ["Prediction failed for order"],
      cancellable: true,
    });
    job.finish();
  });
});
