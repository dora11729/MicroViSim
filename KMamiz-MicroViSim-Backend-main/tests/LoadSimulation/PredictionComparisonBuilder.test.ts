import PredictionComparisonBuilder from "../../src/MicroViSim-simulator/classes/LoadSimulation/PredictionComparisonBuilder";
import { TPredictedLoadsByStrategy } from "../../src/MicroViSim-simulator/classes/LoadSimulation/MLScalingHandler";
import { TMultiStepForecast } from "../../src/MicroViSim-simulator/classes/LoadSimulation/MLModelClient";
import { TPredictedServiceLoad } from "../../src/MicroViSim-simulator/classes/LoadSimulation/PredictedLoadPropagator";
import SimulatorUtils from "../../src/MicroViSim-simulator/classes/SimulatorUtils";
import { multiStepForecasts } from "../../src/MicroViSim-simulator/entities/TSimConfigLoadSimulation";

const Slots = ["0-0-0", "0-1-0", "0-2-0", "1-0-0"];
const Order = SimulatorUtils.generateUniqueServiceName("order", "default", "v1");
// 30 seconds past a minute, so slot dates are floored like the charts' dates.
const SimulateDate = Date.UTC(2025, 0, 1, 0, 0, 30);

// Requests per hour per slot, by strategy; null leaves the slot without a prediction.
function mockLoads(requestsPerHour: Partial<Record<TMultiStepForecast, (number | null)[]>>): TPredictedLoadsByStrategy {
  return new Map(multiStepForecasts.map(strategy => {
    const values = requestsPerHour[strategy] ?? [null, 100, 100, 100];
    return [strategy, new Map(Slots.map((slot, j): [string, Map<string, TPredictedServiceLoad>] => [slot, new Map([[
      Order,
      values[j] === null
        ? { status: "fallback", reason: "insufficientHistory" }
        : { status: "ok", rps: values[j]! / 3600 },
    ]])]))];
  }));
}

function build(actual: number[], requestsPerHour: Partial<Record<TMultiStepForecast, (number | null)[]>>) {
  return new PredictionComparisonBuilder().build({
    sortedTimeSlotKeys: Slots,
    simulateDate: SimulateDate,
    modelServices: new Map([[Order, "gru"]]),
    predictedLoads: mockLoads(requestsPerHour),
    serviceRequestCounts: new Map(Slots.map((slot, j) => [slot, new Map([[Order, actual[j]]])])),
    configuredMethod: "rectify",
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
    expect(build([0, 0, 0, 0], { recursive: [null, 360, 720, 0] }).services[0].predictions.recursive)
      .toEqual([null, expect.closeTo(360), expect.closeTo(720), 0]);
  });

  it("scores every method on the slots all of them forecast", () => {
    const { services: [order] } = build([100, 100, 130, 100], { hourly: [null, null, 100, 100] });
    expect(order.scoredSlots).toBe(2);
    expect(order.errors.recursive).toEqual({ mae: 15, rmse: expect.closeTo(Math.sqrt(450)), maeVsNaive: 0.5 });
    expect(order.errors.naive.mae).toBe(30);
  });

  it("names the service and the method that scaled", () => {
    const comparison = build([0, 0, 0, 0], {});
    expect(comparison.methods).toEqual(["naive", ...multiStepForecasts]);
    expect(comparison.configuredMethod).toBe("rectify");
    expect(comparison.services[0]).toMatchObject({ service: "order", namespace: "default", version: "v1", model: "gru" });
  });

  it("leaves errors empty when no slot has every forecast", () => {
    const { services: [order] } = build([1, 2, 3, 4], { direct: [null, null, null, null] });
    expect(order.scoredSlots).toBe(0);
    expect(order.errors.direct).toEqual({ mae: null, rmse: null, maeVsNaive: null });
  });
});
