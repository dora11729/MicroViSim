import { TForecastGranularity } from "../../entities/TSimConfigLoadSimulation";
import {
  TPredictionComparison,
  TPredictionError,
  TServicePredictionComparison,
} from "../../entities/TPredictionComparison";
import { MLModelType } from "./MLModelClient";
import { comparedForecasts, TForecastPlan } from "./MLScalingHandler";
import Utils from "../../../utils/Utils";

const SECONDS_PER_HOUR = 3600;
const MS_PER_MINUTE = 60_000;
const NAIVE = "naive";

/*
  Scores every forecasting method on the same run: external traffic does not depend on
  scaling, so all of them saw the same history, while only the configured one scaled.
  "actual" is what each service received in the final propagation, as charted; naive
  forecasts it as the previous slot's value.
*/
export default class PredictionComparisonBuilder {
  build(input: {
    sortedTimeSlotKeys: string[];
    simulateDate: number;
    modelServices: Map<string, MLModelType>;
    forecastPlan: TForecastPlan;
    serviceRequestCounts: Map<string, Map<string, number>>;   // slot -> service -> requests
    configuredMethod: TForecastGranularity;
  }): TPredictionComparison {
    const { sortedTimeSlotKeys, forecastPlan, serviceRequestCounts } = input;
    const methods = [NAIVE, ...comparedForecasts];

    const services = Array.from(input.modelServices.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([uniqueServiceName, model]): TServicePredictionComparison => {
        const actual = sortedTimeSlotKeys.map(slot => serviceRequestCounts.get(slot)?.get(uniqueServiceName) ?? 0);
        const predictions: Record<string, (number | null)[]> = {
          [NAIVE]: actual.map((_, j) => (j === 0 ? null : actual[j - 1])),
        };
        for (const method of comparedForecasts) {
          predictions[method] = sortedTimeSlotKeys.map(slot => {
            const load = forecastPlan.loads.get(method)?.get(slot)?.get(uniqueServiceName);
            return load?.status === "ok" ? load.rps * SECONDS_PER_HOUR : null;
          });
        }

        const scored = actual
          .map((_, j) => j)
          .filter(j => methods.every(method => predictions[method][j] !== null));
        const naiveMAE = this.error(actual, predictions[NAIVE], scored).mae;
        const errors: Record<string, TPredictionError> = {};
        for (const method of methods) {
          const { mae, rmse } = this.error(actual, predictions[method], scored);
          errors[method] = { mae, rmse, maeVsNaive: mae !== null && naiveMAE ? mae / naiveMAE : null };
        }

        const [service, namespace, version] = uniqueServiceName.split("\t");
        return {
          uniqueServiceName, service, namespace, version, model,
          actual, predictions, errors, scoredSlots: scored.length,
          minuteChoice: forecastPlan.minuteChoices.get(uniqueServiceName) ?? null,
        };
      });

    return {
      dates: sortedTimeSlotKeys.map(slot => this.slotDate(slot, input.simulateDate)),
      methods,
      configuredMethod: input.configuredMethod,
      services,
    };
  }

  private error(actual: number[], predicted: (number | null)[], slots: number[]) {
    if (slots.length === 0) return { mae: null, rmse: null };
    const diffs = slots.map(j => predicted[j]! - actual[j]);
    return {
      mae: diffs.reduce((sum, d) => sum + Math.abs(d), 0) / slots.length,
      rmse: Math.sqrt(diffs.reduce((sum, d) => sum + d * d, 0) / slots.length),
    };
  }

  // The HistoricalData date the Metrics charts plot for this slot.
  private slotDate(slot: string, simulateDate: number): number {
    const [day, hour, minute] = slot.split("-").map(Number);
    return Utils.BelongsToMinuteTimestamp(simulateDate + ((day * 24 + hour) * 60 + minute) * MS_PER_MINUTE);
  }
}
