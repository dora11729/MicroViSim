/**
 * The loadDriven utilisation invariant.
 *
 * LatencySimulator.computeLoadDriven hardcodes `capacityPerHour = capacity * 3600`
 * because the REAL simulator's slot is an hour. Calibration runs at the CSV's own
 * resolution, and down-scales request counts to bound cost, so the adapter has to
 * pre-scale the per-slot capacity such that
 *
 *     requestCount / (slotCapacity * replicas * 3600) == rps / (capacityPerReplica * replicas)
 *
 * holds for ANY slot duration, with or without the request budget binding.
 */

import { TCMetricsPerTimeSlot } from "../../src/MicroViSim-simulator/entities/TLoadSimulation";
import { SimulatorRunnerAdapter } from "../../src/MicroViSim-simulator/classes/SimConfigConverter/SimulatorRunnerAdapter";
import { SimulatorRunParams } from "../../src/MicroViSim-simulator/classes/SimConfigConverter/ConverterService";

const SERVICE = "auth-service";
const ENDPOINT = "POST /login";
const UNIQUE_ENDPOINT = `${SERVICE}-${ENDPOINT}`;

/**
 * Captures the per-slot maps the adapter hands to the propagator, without running a
 * simulation. `simulatePropagation` is the adapter's only outbound call.
 */
function captureSlots(params: SimulatorRunParams): Map<string, TCMetricsPerTimeSlot> {
  const adapter = new SimulatorRunnerAdapter();
  let captured = new Map<string, TCMetricsPerTimeSlot>();

  const propagator = (adapter as any).propagator;
  jest.spyOn(propagator, "simulatePropagation").mockImplementation(((
    _metrics: unknown,
    _dep: unknown,
    slotMap: Map<string, TCMetricsPerTimeSlot>,
  ) => {
    captured = slotMap;
    return new Map();
  }) as any);

  adapter.runEndpoint(params);
  return captured;
}

function baseParams(overrides: Partial<SimulatorRunParams> = {}): SimulatorRunParams {
  return {
    service: SERVICE,
    endpoint: ENDPOINT,
    delays: [{ type: "loadDriven", latencyMs: 100, jitterMs: 10 }],
    capacityPerReplica: 50,
    slotRps: [10, 10, 10, 10, 10, 10],
    slotReplicaCount: [2, 2, 2, 2, 2, 2],
    slotDurationSeconds: 60,
    errorRate: 0,
    ...overrides,
  };
}

/** rho exactly as LatencySimulator.computeLoadDriven would compute it. */
function simulatedRho(slot: TCMetricsPerTimeSlot): number {
  const replicas = slot.getServiceReplicaCount(SERVICE);
  const capacity = slot.getServiceCapacityPerReplica(SERVICE) * replicas;
  const requestCount = slot.getEntryPointRequestCount(UNIQUE_ENDPOINT);
  return requestCount / (capacity * 3600);
}

describe("SimulatorRunnerAdapter preserves the true utilisation ratio", () => {
  afterEach(() => jest.restoreAllMocks());

  for (const slotDurationSeconds of [60, 300, 3600]) {
    it(`matches rps/(capacityPerReplica*replicas) at ${slotDurationSeconds}s slots`, () => {
      const rps = 10;
      const capacityPerReplica = 50;
      const replicas = 2;

      const slots = captureSlots(baseParams({
        slotDurationSeconds,
        capacityPerReplica,
        slotRps: new Array(6).fill(rps),
        slotReplicaCount: new Array(6).fill(replicas),
      }));

      const expected = rps / (capacityPerReplica * replicas);
      for (const slot of slots.values()) {
        expect(simulatedRho(slot)).toBeCloseTo(expected, 9);
      }
    });
  }

  it("stays exact when the per-run request budget caps the slot", () => {
    // 500 rps over 300s = 150 000 requests, far above the budget — the cap binds.
    const rps = 500;
    const capacityPerReplica = 800;
    const replicas = 3;

    const slots = captureSlots(baseParams({
      slotDurationSeconds: 300,
      capacityPerReplica,
      slotRps: new Array(6).fill(rps),
      slotReplicaCount: new Array(6).fill(replicas),
    }));

    const expected = rps / (capacityPerReplica * replicas);
    for (const slot of slots.values()) {
      expect(slot.getEntryPointRequestCount(UNIQUE_ENDPOINT)).toBeLessThan(rps * 300);
      expect(simulatedRho(slot)).toBeCloseTo(expected, 9);
    }
  });

  it("simulates at least one request when traffic was observed but rounds below 1", () => {
    // 0.004 rps over 60s = 0.24 requests. Rounding to 0 would report p50 = 0 against a
    // non-zero observation — a structural 100% MAPE contribution.
    const slots = captureSlots(baseParams({
      slotDurationSeconds: 60,
      slotRps: new Array(6).fill(0.004),
    }));

    for (const slot of slots.values()) {
      expect(slot.getEntryPointRequestCount(UNIQUE_ENDPOINT)).toBe(1);
      // rho stays true despite the floor, because scale is derived from the realised count.
      expect(simulatedRho(slot)).toBeCloseTo(0.004 / (50 * 2), 9);
    }
  });

  it("emits zero requests and never a zero capacity for a genuinely idle slot", () => {
    const slots = captureSlots(baseParams({
      slotRps: [10, 0, 10, 0, 10, 10],
    }));

    const idle = Array.from(slots.values())[1];
    expect(idle.getEntryPointRequestCount(UNIQUE_ENDPOINT)).toBe(0);
    // A literal 0 capacity would make capacityPerHour 0 and rho Infinity → clamped to
    // 0.95, i.e. fake saturation.
    expect(idle.getServiceCapacityPerReplica(SERVICE)).toBeGreaterThan(0);
  });

  it("creates one slot per entry in slotRps, not a fixed 24", () => {
    const slots = captureSlots(baseParams({
      slotRps: new Array(15).fill(10),
      slotReplicaCount: new Array(15).fill(2),
    }));
    expect(slots.size).toBe(15);
  });

  it("uses each slot's own replica count", () => {
    const slots = captureSlots(baseParams({
      slotReplicaCount: [1, 2, 3, 4, 5, 6],
    }));
    const replicas = Array.from(slots.values()).map(s => s.getServiceReplicaCount(SERVICE));
    expect(replicas).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
