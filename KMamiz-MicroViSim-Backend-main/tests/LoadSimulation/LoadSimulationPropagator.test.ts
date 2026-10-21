import LoadSimulationPropagator from "../../src/MicroViSim-simulator/classes/LoadSimulation/LoadSimulationPropagator";
import SimulatorUtils from "../../src/MicroViSim-simulator/classes/SimulatorUtils";
import {
  TCMetricsPerTimeSlot,
  TDependOnMapWithCallProbability,
} from "../../src/MicroViSim-simulator/entities/TLoadSimulation";

const Slot = "0-0-0";
const Requests = 10;

const endpoint = (name: string) => SimulatorUtils.generateUniqueEndpointName(name, "default", "v1", "GET", "/");

const Gateway = endpoint("gateway");
const Order = endpoint("order");
const User = endpoint("user");

function mockDependOn(groups: Record<string, string[][]>): TDependOnMapWithCallProbability {
  return new Map(Object.entries(groups).map(([caller, g]) => [caller, g.map(group =>
    group.map(targetEndpointUniqueEndpointName => ({ targetEndpointUniqueEndpointName, callProbability: 100 })))]));
}

function simulate(groups: Record<string, string[][]>, errorRates: Record<string, number> = {}) {
  const metrics = new TCMetricsPerTimeSlot();
  metrics.setEntryPointRequestCount(Gateway, Requests);
  Object.entries(errorRates).forEach(([e, rate]) => metrics.setEndpointErrorRate(e, rate));
  return new LoadSimulationPropagator()
    .simulatePropagation([], mockDependOn(groups), new Map([[Slot, metrics]]), false)
    .get(Slot)!;
}

describe("LoadSimulationPropagator", () => {
  it("calls an endpoint once per path of a diamond", () => {
    const stats = simulate({ [Gateway]: [[User], [Order]], [Order]: [[User]] });
    expect(stats.get(User)!.requestCount).toBe(2 * Requests);
  });

  it("stops a request re-entering an endpoint on its path", () => {
    const stats = simulate({ [Gateway]: [[Order]], [Order]: [[User]], [User]: [[Order]] });
    expect(stats.get(Order)!.requestCount).toBe(Requests);
    expect(stats.get(User)!.requestCount).toBe(Requests);
  });

  it("reports a diamond's second call back to its caller", () => {
    // gateway reaches user directly first, so order's call is the second one.
    const stats = simulate({ [Gateway]: [[User], [Order]], [Order]: [[User]] }, { [User]: 1 });
    expect(stats.get(Order)!.downstreamErrorCount).toBe(Requests);
  });
});
