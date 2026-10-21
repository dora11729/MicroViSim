import LoadSimulationPropagator from "../../src/MicroViSim-simulator/classes/LoadSimulation/LoadSimulationPropagator";
import PredictedLoadPropagator, {
  TServiceTrafficProfile,
} from "../../src/MicroViSim-simulator/classes/LoadSimulation/PredictedLoadPropagator";
import SimulatorUtils from "../../src/MicroViSim-simulator/classes/SimulatorUtils";
import {
  TCMetricsPerTimeSlot,
  TDependOnMapWithCallProbability,
} from "../../src/MicroViSim-simulator/entities/TLoadSimulation";

const SecondsPerHour = 3600;
const Slots = ["0-0-0", "0-1-0"];

const service = (name: string) => SimulatorUtils.generateUniqueServiceName(name, "default", "v1");
const endpoint = (name: string, path = "/") =>
  SimulatorUtils.generateUniqueEndpointName(name, "default", "v1", "GET", path);

const Gateway = service("gateway");
const Order = service("order");
const Payment = service("payment");
const User = service("user");
const GatewayApi = endpoint("gateway", "/api");
const GatewayAdmin = endpoint("gateway", "/admin");
const OrderApi = endpoint("order");
const PaymentApi = endpoint("payment");
const UserApi = endpoint("user");

function mockProfile(daily: Record<string, number>): TServiceTrafficProfile {
  const profile: TServiceTrafficProfile = {
    endpointDaily: new Map(), serviceDaily: new Map(), endpointsOfService: new Map(),
  };
  for (const [e, d] of Object.entries(daily)) {
    const s = SimulatorUtils.extractUniqueServiceNameFromEndpointName(e);
    profile.endpointDaily.set(e, d);
    profile.serviceDaily.set(s, (profile.serviceDaily.get(s) ?? 0) + d);
    profile.endpointsOfService.set(s, [...(profile.endpointsOfService.get(s) ?? []), e]);
  }
  return profile;
}

function mockDependOn(groups: Record<string, [string, number][][]>): TDependOnMapWithCallProbability {
  return new Map(Object.entries(groups).map(([caller, g]) => [caller, g.map(group =>
    group.map(([targetEndpointUniqueEndpointName, callProbability]) =>
      ({ targetEndpointUniqueEndpointName, callProbability })))]));
}

function mockArrivals(external: Record<string, number>) {
  const metrics = new TCMetricsPerTimeSlot();
  Object.entries(external).forEach(([e, count]) => metrics.setEntryPointRequestCount(e, count));
  return metrics;
}

function propagate(input: {
  daily: Record<string, number>;
  dependOn?: Record<string, [string, number][][]>;
  observedExternal?: Record<string, number>;   // RPS in slot 0, the only slot slot 1 may look at
  ownPredictions?: Record<string, (number | null)[] | null>;
  modelServices: string[];
}) {
  return new PredictedLoadPropagator().propagate({
    sortedTimeSlotKeys: Slots,
    profile: mockProfile(input.daily),
    dependOnMap: mockDependOn(input.dependOn ?? {}),
    metricsPerTimeSlotMap: new Map([
      [Slots[0], mockArrivals(Object.fromEntries(Object.entries(input.observedExternal ?? {})
        .map(([e, rps]) => [e, rps * SecondsPerHour])))],
      [Slots[1], new TCMetricsPerTimeSlot()],
    ]),
    ownPredictions: new Map(Object.entries(input.ownPredictions ?? {})),
    modelServices: input.modelServices,
  });
}

const loadOf = (table: ReturnType<typeof propagate>, s: string) => table.get(Slots[1])!.get(s);

describe("PredictedLoadPropagator", () => {
  it("splits a service's prediction over its endpoints by daily volume", () => {
    const table = propagate({
      daily: { [GatewayApi]: 3000, [GatewayAdmin]: 1000, [OrderApi]: 0 },
      dependOn: { [GatewayApi]: [[[OrderApi, 100]]] },
      ownPredictions: { [Gateway]: [null, 8] },
      modelServices: [Gateway, Order],
    });
    expect(loadOf(table, Gateway)).toEqual({ status: "ok", rps: 8 });
    expect(loadOf(table, Order)).toEqual({ status: "ok", rps: 6 });
  });

  it("weights a predicted caller by its call probability", () => {
    const table = propagate({
      daily: { [GatewayApi]: 1000, [OrderApi]: 0 },
      dependOn: { [GatewayApi]: [[[OrderApi, 30]]] },
      ownPredictions: { [Gateway]: [null, 10] },
      modelServices: [Order],
    });
    expect(loadOf(table, Order)).toEqual({ status: "ok", rps: expect.closeTo(3, 10) });
  });

  it("uses the last observed external traffic of an entry with no prediction", () => {
    const table = propagate({
      daily: { [GatewayApi]: 1000, [PaymentApi]: 1000, [OrderApi]: 0 },
      dependOn: { [GatewayApi]: [[[OrderApi, 50]]], [PaymentApi]: [[[OrderApi, 50]]] },
      observedExternal: { [PaymentApi]: 20 },
      ownPredictions: { [Gateway]: [null, 10] },
      modelServices: [Order],
    });
    expect(loadOf(table, Order)).toEqual({ status: "ok", rps: 15 });
  });

  it("counts every path of a diamond", () => {
    const table = propagate({
      daily: { [GatewayApi]: 1000, [OrderApi]: 0, [UserApi]: 0 },
      dependOn: { [GatewayApi]: [[[OrderApi, 50]], [[UserApi, 50]]], [OrderApi]: [[[UserApi, 50]]] },
      ownPredictions: { [Gateway]: [null, 10] },
      modelServices: [User],
    });
    expect(loadOf(table, User)).toEqual({ status: "ok", rps: 7.5 });
  });

  it("calls a target picked by several groups once", () => {
    const table = propagate({
      daily: { [GatewayApi]: 1000, [OrderApi]: 0 },
      dependOn: { [GatewayApi]: [[[OrderApi, 20]], [[OrderApi, 30]]] },
      ownPredictions: { [Gateway]: [null, 10] },
      modelServices: [Order],
    });
    expect(loadOf(table, Order)).toEqual({ status: "ok", rps: expect.closeTo(4.4, 10) });
  });

  it("falls back when nothing upstream is predicted", () => {
    const table = propagate({
      daily: { [PaymentApi]: 1000, [OrderApi]: 0 },
      dependOn: { [PaymentApi]: [[[OrderApi, 100]]] },
      observedExternal: { [PaymentApi]: 20 },
      modelServices: [Order],
    });
    expect(loadOf(table, Order)).toEqual({ status: "fallback", reason: "noPredictionSource" });
  });

  it("tells a short history apart from an unavailable ML service", () => {
    const table = propagate({
      daily: { [GatewayApi]: 1000, [PaymentApi]: 1000 },
      ownPredictions: { [Gateway]: [null, null], [Payment]: null },
      modelServices: [Gateway, Payment],
    });
    expect(loadOf(table, Gateway)).toEqual({ status: "fallback", reason: "insufficientHistory" });
    expect(loadOf(table, Payment)).toEqual({ status: "fallback", reason: "serviceUnavailable" });
  });

  it("stops a call that re-enters its own path", () => {
    const table = propagate({
      daily: { [GatewayApi]: 1000, [OrderApi]: 0 },
      dependOn: { [GatewayApi]: [[[OrderApi, 100]]], [OrderApi]: [[[GatewayApi, 10]]] },
      ownPredictions: { [Gateway]: [null, 10] },
      modelServices: [Gateway, Order],
    });
    expect(loadOf(table, Gateway)).toEqual({ status: "ok", rps: 10 });
    expect(loadOf(table, Order)).toEqual({ status: "ok", rps: 10 });
  });

  it("matches the simulator's calls per request", () => {
    const requests = 20000;
    // A diamond, a cycle and a target picked by two groups.
    const dependOn = {
      [GatewayApi]: [[[OrderApi, 50]], [[UserApi, 50]], [[UserApi, 20]]],
      [OrderApi]: [[[UserApi, 50], [PaymentApi, 30]]],
      [PaymentApi]: [[[OrderApi, 40]]],
    } as Record<string, [string, number][][]>;
    const simulated = new LoadSimulationPropagator().simulatePropagation([], mockDependOn(dependOn),
      new Map([[Slots[0], mockArrivals({ [GatewayApi]: requests })]]), false).get(Slots[0])!;

    const table = propagate({
      daily: { [GatewayApi]: 1000, [OrderApi]: 0, [UserApi]: 0, [PaymentApi]: 0 },
      dependOn,
      ownPredictions: { [Gateway]: [null, 1] },
      modelServices: [Order, User, Payment],
    });
    for (const [s, e] of [[Order, OrderApi], [User, UserApi], [Payment, PaymentApi]]) {
      expect(loadOf(table, s)).toEqual(
        { status: "ok", rps: expect.closeTo(simulated.get(e)!.requestCount / requests, 1) });
    }
  });

  it("leaves the first slot out", () => {
    const table = propagate({ daily: { [GatewayApi]: 1000 }, modelServices: [Gateway] });
    expect(table.has(Slots[0])).toBe(false);
  });
});
