import PredictionAccuracyTracker from "../../src/MicroViSim-simulator/classes/LoadSimulation/PredictionAccuracyTracker";

const Service = "order\tdefault\tv1";

describe("PredictionAccuracyTracker", () => {
  it("scores the model and the naive predictor separately", () => {
    const tracker = new PredictionAccuracyTracker();
    tracker.record(Service, "lstm", { actual: 10, predicted: 12, naive: 14 });
    tracker.record(Service, "lstm", { actual: 10, predicted: 8, naive: 4 });

    const [accuracy] = tracker.getAccuracies();
    expect(accuracy.model).toBe("lstm");
    expect(accuracy.slots).toBe(2);
    expect(accuracy.modelMAE).toBeCloseTo(2, 10);
    expect(accuracy.modelRMSE).toBeCloseTo(2, 10);
    expect(accuracy.naiveMAE).toBeCloseTo(5, 10);
    expect(accuracy.naiveRMSE).toBeCloseTo(Math.sqrt(26), 10);
  });

  it("reports a perfect prediction as zero error", () => {
    const tracker = new PredictionAccuracyTracker();
    tracker.record(Service, "xgboost", { actual: 7, predicted: 7, naive: 3 });

    const [accuracy] = tracker.getAccuracies();
    expect(accuracy.modelMAE).toBe(0);
    expect(accuracy.modelRMSE).toBe(0);
    expect(accuracy.naiveMAE).toBeCloseTo(4, 10);
  });

  it("keeps services apart", () => {
    const tracker = new PredictionAccuracyTracker();
    tracker.record(Service, null, { actual: 10, predicted: 10, naive: 10 });
    tracker.record("payment\tdefault\tv1", null, { actual: 10, predicted: 5, naive: 5 });

    const accuracies = tracker.getAccuracies();
    expect(accuracies).toHaveLength(2);
    expect(accuracies[0].model).toBeNull();
    expect(accuracies[0].modelMAE).toBe(0);
    expect(accuracies[1].modelMAE).toBeCloseTo(5, 10);
  });

  it("has nothing to report before any decision", () => {
    expect(new PredictionAccuracyTracker().getAccuracies()).toEqual([]);
  });
});
