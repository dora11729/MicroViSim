export const minuteStrategies = ["linearInput", "rectify"] as const;
export type TMinuteStrategy = typeof minuteStrategies[number];

const SELECTION_WINDOW_HOURS = 24;
// Used when there is nothing to compare yet, and on a tie.
const DEFAULT_STRATEGY: TMinuteStrategy = "linearInput";

/*
  The one-minute models' forecast for each hour: of linearInput and rectify, whichever
  forecast the service's external share more closely (MAE) over up to the last 24 hours
  before it. Only past hours count, so the pick for hour t never sees hour t. Hours where
  either strategy has no forecast are left out of the comparison.
*/
export default class MinuteForecastSelector {
  select(
    observed: number[],
    forecasts: Record<TMinuteStrategy, (number | null)[]>
  ): { shares: (number | null)[]; chosen: (TMinuteStrategy | null)[] } {
    const shares: (number | null)[] = [];
    const chosen: (TMinuteStrategy | null)[] = [];

    for (let t = 0; t < observed.length; t++) {
      const preferred = this.pick(observed, forecasts, t);
      // A strategy without a forecast for this hour gives way to the other.
      const strategy = [preferred, ...minuteStrategies.filter(s => s !== preferred)]
        .find(s => forecasts[s][t] !== null && forecasts[s][t] !== undefined);
      shares.push(strategy ? forecasts[strategy][t] : null);
      chosen.push(strategy ?? null);
    }
    return { shares, chosen };
  }

  private pick(
    observed: number[],
    forecasts: Record<TMinuteStrategy, (number | null)[]>,
    t: number
  ): TMinuteStrategy {
    const totals = { linearInput: 0, rectify: 0 };
    let compared = 0;
    for (let s = Math.max(0, t - SELECTION_WINDOW_HOURS); s < t; s++) {
      const linear = forecasts.linearInput[s];
      const rectify = forecasts.rectify[s];
      if (linear === null || linear === undefined || rectify === null || rectify === undefined) continue;
      totals.linearInput += Math.abs(linear - observed[s]);
      totals.rectify += Math.abs(rectify - observed[s]);
      compared++;
    }
    if (compared === 0) return DEFAULT_STRATEGY;
    return totals.rectify < totals.linearInput ? "rectify" : DEFAULT_STRATEGY;
  }
}
