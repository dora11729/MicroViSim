import MLModelClient, { MLModelType } from "../../src/MicroViSim-simulator/classes/LoadSimulation/MLModelClient";
import MLScalingHandler from "../../src/MicroViSim-simulator/classes/LoadSimulation/MLScalingHandler";
import SimulatorUtils from "../../src/MicroViSim-simulator/classes/SimulatorUtils";
import { TCMetricsPerTimeSlot } from "../../src/MicroViSim-simulator/entities/TLoadSimulation";
import {
  TSimulationEndpointMetric,
  TSimulationNamespaceServiceMetrics,
} from "../../src/MicroViSim-simulator/entities/TSimConfigLoadSimulation";

const Slots = ["0-0-0", "0-1-0", "0-2-0"];

const service = (name: string) => SimulatorUtils.generateUniqueServiceName(name, "default", "v1");
const endpoint = (name: string, path = "/") =>
  SimulatorUtils.generateUniqueEndpointName(name, "default", "v1", "GET", path);

const Gateway = service("gateway");
const Order = service("order");
const GatewayApi = endpoint("gateway", "/api");
const GatewayAdmin = endpoint("gateway", "/admin");
const OrderApi = endpoint("order");

function mockEndpointMetrics(daily: Record<string, number>): TSimulationEndpointMetric[] {
  return Object.entries(daily).map(([uniqueEndpointName, expectedExternalDailyRequestCount]) => ({
    uniqueEndpointName,
    endpointId: uniqueEndpointName,
    delay: [{ type: "jitter", latencyMs: 0, jitterMs: 0 }],
    maxLatencyMs: 0,
    timeoutMs: 0,
    errorRatePercentage: 0,
    expectedExternalDailyRequestCount,
    fallbackStrategy: "failIfAnyDependentFail",
  }));
}

function mockServiceMetrics(models: Record<string, MLModelType | undefined>): TSimulationNamespaceServiceMetrics[] {
  return [{
    namespace: "default",
    services: Object.entries(models).map(([uniqueServiceName, model]) => ({
      serviceName: SimulatorUtils.splitUniqueServiceName(uniqueServiceName)[0],
      versions: [{
        uniqueServiceName,
        version: "v1",
        capacityPerReplica: 10,
        autoScaling: { model, targetUtilization: 0.7, tolerance: 0.1, maxScaleStep: 2, maxReplicas: 10 },
      }],
    })),
  }];
}

function mockExternalArrivals(perSlot: Record<string, number>[]): Map<string, TCMetricsPerTimeSlot> {
  return new Map(perSlot.map((counts, i) => {
    const metrics = new TCMetricsPerTimeSlot();
    Object.entries(counts).forEach(([e, count]) => metrics.setEntryPointRequestCount(e, count));
    return [Slots[i], metrics];
  }));
}

describe("MLScalingHandler", () => {
  const handler = MLScalingHandler.getInstance();
  const client = MLModelClient.getInstance();

  afterEach(() => jest.restoreAllMocks());

  it("adds up a service's daily requests over its endpoints", () => {
    const profile = handler.buildTrafficProfile(
      mockEndpointMetrics({ [GatewayApi]: 3000, [GatewayAdmin]: 1000, [OrderApi]: 0 }));
    expect(profile.serviceDaily.get(Gateway)).toBe(4000);
    expect(profile.endpointsOfService.get(Gateway)).toEqual([GatewayApi, GatewayAdmin]);
    expect(profile.serviceDaily.get(Order)).toBe(0);
  });

  it("trains only model services that receive external traffic", () => {
    const profile = handler.buildTrafficProfile(mockEndpointMetrics({ [GatewayApi]: 4000, [OrderApi]: 0 }));
    const models = handler.modelServices(mockServiceMetrics({ [Order]: "gru", [Gateway]: "arima" }));
    expect(handler.trainingServices(profile, models)).toEqual([
      { service: Gateway, model: "arima", dailyRequestCount: 4000 },
    ]);
  });

  it("reads the share from external arrivals", () => {
    const profile = handler.buildTrafficProfile(mockEndpointMetrics({ [GatewayApi]: 3000, [GatewayAdmin]: 1000 }));
    const metrics = mockExternalArrivals([
      { [GatewayApi]: 150, [GatewayAdmin]: 50 },
      { [GatewayApi]: 300, [GatewayAdmin]: 100 },
    ]);
    expect(handler.observedShares(Gateway, profile, Slots.slice(0, 2), metrics)).toEqual([5, 10]);
  });

  it("turns a share into RPS through the daily total", () => {
    expect(handler.shareToRPS(5, 360000)).toBeCloseTo(5, 10);
    expect(handler.shareToRPS(-2, 360000)).toBe(0);
  });

  it("stays off the ML service when no service names a model", async () => {
    const train = jest.spyOn(client, "train");
    const table = await handler.planPredictedLoads({
      serviceMetrics: mockServiceMetrics({ [Gateway]: undefined }),
      endpointMetrics: mockEndpointMetrics({ [GatewayApi]: 4000 }),
      dependOnMap: new Map(),
      metricsPerTimeSlotMap: mockExternalArrivals([{}, {}, {}]),
      sortedTimeSlotKeys: Slots,
    });
    expect(train).not.toHaveBeenCalled();
    expect(table.size).toBe(0);
  });

  it("predicts each trained service from its observed shares", async () => {
    jest.spyOn(client, "train").mockResolvedValue();
    const predictShares = jest.spyOn(client, "predictShares").mockResolvedValue([null, 10, 20]);

    const table = await handler.planPredictedLoads({
      serviceMetrics: mockServiceMetrics({ [Gateway]: "bilstm" }),
      endpointMetrics: mockEndpointMetrics({ [GatewayApi]: 360000 }),
      dependOnMap: new Map(),
      metricsPerTimeSlotMap: mockExternalArrivals([{ [GatewayApi]: 3600 }, { [GatewayApi]: 7200 }, {}]),
      sortedTimeSlotKeys: Slots,
    });

    expect(predictShares).toHaveBeenCalledWith(Gateway, "bilstm", [1, 2, 0]);
    expect(table.get(Slots[1])!.get(Gateway)).toEqual({ status: "ok", rps: 10 });
    expect(table.get(Slots[2])!.get(Gateway)).toEqual({ status: "ok", rps: 20 });
  });
});
