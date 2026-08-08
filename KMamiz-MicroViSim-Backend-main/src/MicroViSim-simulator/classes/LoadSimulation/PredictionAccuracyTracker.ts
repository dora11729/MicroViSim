type TErrorAccumulator = { count: number; absError: number; squaredError: number };

type TServiceStats = {
  model: string | null;
  modelError: TErrorAccumulator;
  naiveError: TErrorAccumulator;
};

export type TPredictionAccuracy = {
  uniqueServiceName: string;
  model: string | null;
  slots: number;
  modelMAE: number;
  modelRMSE: number;
  naiveMAE: number;
  naiveRMSE: number;
};

/*
  Scores each auto-scaling decision against the traffic that slot actually received.

  The naive column is the same reactive decision made without any model (next RPS = last
  observed RPS). A model that cannot beat it has learnt nothing about the workload, which
  is the only way to tell whether a low MAE is skill or just a flat workload.
*/
export default class PredictionAccuracyTracker {
  private stats = new Map<string, TServiceStats>();

  record(
    uniqueServiceName: string,
    model: string | null,
    values: { actual: number; predicted: number; naive: number }
  ) {
    if (!this.stats.has(uniqueServiceName)) {
      this.stats.set(uniqueServiceName, {
        model,
        modelError: this.emptyAccumulator(),
        naiveError: this.emptyAccumulator(),
      });
    }
    const serviceStats = this.stats.get(uniqueServiceName)!;
    this.accumulate(serviceStats.modelError, values.predicted - values.actual);
    this.accumulate(serviceStats.naiveError, values.naive - values.actual);
  }

  getAccuracies(): TPredictionAccuracy[] {
    return Array.from(this.stats.entries()).map(([uniqueServiceName, serviceStats]) => ({
      uniqueServiceName,
      model: serviceStats.model,
      slots: serviceStats.modelError.count,
      modelMAE: this.mae(serviceStats.modelError),
      modelRMSE: this.rmse(serviceStats.modelError),
      naiveMAE: this.mae(serviceStats.naiveError),
      naiveRMSE: this.rmse(serviceStats.naiveError),
    }));
  }

  report() {
    for (const accuracy of this.getAccuracies()) {
      if (accuracy.slots === 0) continue;

      // Without a model the two columns are identical, so only the naive one is useful.
      if (accuracy.model === null) {
        console.log(
          `[Prediction] ${accuracy.uniqueServiceName} (reactive, ${accuracy.slots} slots): ` +
          `MAE=${accuracy.naiveMAE.toFixed(4)} RMSE=${accuracy.naiveRMSE.toFixed(4)}`
        );
        continue;
      }

      const improvement = accuracy.naiveMAE > 0
        ? ` (${(((accuracy.naiveMAE - accuracy.modelMAE) / accuracy.naiveMAE) * 100).toFixed(1)}% vs naive)`
        : "";
      console.log(
        `[Prediction] ${accuracy.uniqueServiceName} (${accuracy.model}, ${accuracy.slots} slots): ` +
        `MAE model=${accuracy.modelMAE.toFixed(4)} naive=${accuracy.naiveMAE.toFixed(4)}${improvement} | ` +
        `RMSE model=${accuracy.modelRMSE.toFixed(4)} naive=${accuracy.naiveRMSE.toFixed(4)}`
      );
    }
  }

  private emptyAccumulator(): TErrorAccumulator {
    return { count: 0, absError: 0, squaredError: 0 };
  }

  private accumulate(accumulator: TErrorAccumulator, error: number) {
    accumulator.count += 1;
    accumulator.absError += Math.abs(error);
    accumulator.squaredError += error * error;
  }

  private mae(accumulator: TErrorAccumulator): number {
    return accumulator.count === 0 ? 0 : accumulator.absError / accumulator.count;
  }

  private rmse(accumulator: TErrorAccumulator): number {
    return accumulator.count === 0 ? 0 : Math.sqrt(accumulator.squaredError / accumulator.count);
  }
}
