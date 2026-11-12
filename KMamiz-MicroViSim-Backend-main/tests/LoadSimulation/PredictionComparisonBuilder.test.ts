import PredictionComparisonBuilder from "../../src/MicroViSim-simulator/classes/LoadSimulation/PredictionComparisonBuilder";
import {
  comparedForecasts,
  TComparedForecast,
  TPredictedLoadsByStrategy,
} from "../../src/MicroViSim-simulator/classes/LoadSimulation/MLScalingHandler";
import { TMinuteStrategy } from "../../src/MicroViSim-simulator/classes/LoadSimulation/MinuteForecastSelector";
import { TPredictedServiceLoad } from "../../src/MicroViSim-simulator/classes/LoadSimulation/PredictedLoadPropagator";
import SimulatorUtils from "../../src/MicroViSim-simulator/classes/SimulatorUtils";

const Slots = ["0-0-0", "0-1-0", "0-2-0", "1-0-0"];
const Order = SimulatorUtils.generateUniqueServiceName("order", "default", "v1");
// 30 seconds past a minute, so slot dates are floored like the charts' dates.
const SimulateDate = Date.UTC(2025, 0, 1, 0, 0, 30);

// Requests per hour per slot, by strategy; null leaves the slot without a prediction.
function mockLoads(requestsPerHour: Partial<Record<TComparedForecast, (number | null)[]>>): TPredictedLoadsByStrategy {
  return new Map(comparedForecasts.map(strategy => {
    const values = requestsPerHour[strategy] ?? [null, 100, 100, 100];
    return [strategy, new Map(Slots.map((slot, j): [string, Map<string, TPredictedServiceLoad>] => [slot, new Map([[
      Order,
      values[j] === null
        ? { status: "fallback", reason: "insufficientHistory" }
        : { status: "ok", rps: values[j]! / 3600 },
    ]])]))];
  }));
}

function build(
  actual: number[],
  requestsPerHour: Partial<Record<TComparedForecast, (number | null)[]>>,
  minuteChoices = new Map<string, (TMinuteStrategy | null)[]>()
) {
  return new PredictionComparisonBuilder().build({
    sortedTimeSlotKeys: Slots,
    simulateDate: SimulateDate,
    modelServices: new Map([[Order, "gru"]]),
    forecastPlan: { loads: mockLoads(requestsPerHour), minuteChoices },
    serviceRequestCounts: new Map(Slots.map((slot, j) => [slot, new Map([[Order, actual[j]]])])),
    configuredMethod: "minute",
  });
}

describe("PredictionComparisonBuilder", () => {
  it("dates each slot like the Metrics charts", () => {
    const start = Date.UTC(2025, 0, 1);
    expect(build([0, 0, 0, 0], {}).dates).toEqual([start, start + 3600e3, start + 7200e3, start + 86400e3]);
  });

  it("forecasts naive as the previous slot", () => {
    expect(build([10, 20, 30, 40], {}).services[0].predictions.naive).toEqual([null, 10, 20, 30]);
  });

  it("converts predicted RPS to requests per hour", () => {
    expect(build([0, 0, 0, 0], { linearInput: [null, 360, 720, 0] }).services[0].predictions.linearInput)
      .toEqual([null, expect.closeTo(360), expect.closeTo(720), 0]);
  });

  it("scores every method on the slots all of them forecast", () => {
    const { services: [order] } = build([100, 100, 130, 100], { hourly: [null, null, 100, 100] });
    expect(order.scoredSlots).toBe(2);
    expect(order.errors.linearInput).toEqual({ mae: 15, rmse: expect.closeTo(Math.sqrt(450)), maeVsNaive: 0.5 });
    expect(order.errors.naive.mae).toBe(30);
  });

  it("names the service and the method that scaled", () => {
    const comparison = build([0, 0, 0, 0], {});
    expect(comparison.methods).toEqual(["naive", "linearInput", "rectify", "minute", "hourly"]);
    expect(comparison.configuredMethod).toBe("minute");
    expect(comparison.services[0]).toMatchObject({ service: "order", namespace: "default", version: "v1", model: "gru" });
  });

  it("leaves errors empty when no slot has every forecast", () => {
    const { services: [order] } = build([1, 2, 3, 4], { rectify: [null, null, null, null] });
    expect(order.scoredSlots).toBe(0);
    expect(order.errors.rectify).toEqual({ mae: null, rmse: null, maeVsNaive: null });
  });

  it("passes on which strategy the minute forecast used", () => {
    const chosen: (TMinuteStrategy | null)[] = [null, "linearInput", "rectify", "rectify"];
    expect(build([0, 0, 0, 0], {}, new Map([[Order, chosen]])).services[0].minuteChoice).toEqual(chosen);
    expect(build([0, 0, 0, 0], {}).services[0].minuteChoice).toBeNull();
  });
});
