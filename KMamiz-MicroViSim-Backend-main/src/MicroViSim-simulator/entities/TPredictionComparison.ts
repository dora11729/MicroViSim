// Every model-scaled service's next-hour forecasts, by each method, beside what it received.
// Counts are requests per hour, the unit of the Metrics page's Requests chart.

export type TPredictionError = {
  mae: number | null;         // null when no slot could be scored
  rmse: number | null;
  maeVsNaive: number | null;  // mae / naive's mae; below 1 beats naive
};

export type TServicePredictionComparison = {
  uniqueServiceName: string;
  service: string;
  namespace: string;
  version: string;
  model: string;
  actual: number[];                                  // aligned with dates
  // predictions[method][j] forecasts dates[j] from earlier slots only; null where the
  // method had none.
  predictions: Record<string, (number | null)[]>;
  // Over the slots every method forecast, so the methods are scored on the same hours.
  errors: Record<string, TPredictionError>;
  scoredSlots: number;
};

export type TPredictionComparison = {
  dates: number[];            // epoch ms, the same x values as the Metrics charts
  methods: string[];          // "naive" first
  configuredMethod: string;   // the one that drove scaling
  services: TServicePredictionComparison[];
};
