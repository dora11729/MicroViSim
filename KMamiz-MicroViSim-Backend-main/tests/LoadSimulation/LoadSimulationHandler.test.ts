import LoadSimulationHandler from "../../src/MicroViSim-simulator/classes/LoadSimulation/LoadSimulationHandler";
import SimulatorUtils from "../../src/MicroViSim-simulator/classes/SimulatorUtils";
import {
  TCMetricsPerTimeSlot,
  TEndpointPropagationStatsForOneTimeSlot,
} from "../../src/MicroViSim-simulator/entities/TLoadSimulation";
import { TSimulationNamespaceServiceMetrics } from "../../src/MicroViSim-simulator/entities/TSimConfigLoadSimulation";

const SecondsPerHour = 3600;
const ServiceName = "order";
const Namespace = "default";
const Version = "v1";

const UniqueServiceName = SimulatorUtils.generateUniqueServiceName(ServiceName, Namespace, Version);
const UniqueEndpointName = SimulatorUtils.generateUniqueEndpointName(
  ServiceName, Namespace, Version, "GET", "/orders"
);

function mockServiceMetrics(scaling: {
  maxScaleStep?: number;
  maxReplicas?: number;
} = {}): TSimulationNamespaceServiceMetrics[] {
  return [
    {
      namespace: Namespace,
      services: [
        {
          serviceName: ServiceName,
          versions: [
            {
              uniqueServiceName: UniqueServiceName,
              version: Version,
              capacityPerReplica: 10,
              autoScaling: {
                targetUtilization: 0.7,
                tolerance: 0.1,
                maxScaleStep: scaling.maxScaleStep ?? 2,
                maxReplicas: scaling.maxReplicas ?? 10,
              },
            },
          ],
        },
      ],
    },
  ];
}

function mockStats(requestCount: number): TEndpointPropagationStatsForOneTimeSlot {
  return {
    requestCount,
    ownErrorCount: 0,
    downstreamErrorCount: 0,
    latencyStatsByStatus: new Map(),
    ownLatencyStatsByStatus: new Map(),
  };
}

// Slot i is keyed "0-i-0" and receives rpsPerSlot[i] requests per second.
function mockTimeline(rpsPerSlot: number[], baseReplicaCount: number) {
  const propagationResults = new Map<string, Map<string, TEndpointPropagationStatsForOneTimeSlot>>();
  const metricsPerTimeSlotMap = new Map<string, TCMetricsPerTimeSlot>();

  rpsPerSlot.forEach((rps, slotIndex) => {
    const timeSlotKey = `0-${slotIndex}-0`;
    propagationResults.set(timeSlotKey, new Map([[UniqueEndpointName, mockStats(rps * SecondsPerHour)]]));

    const metrics = new TCMetricsPerTimeSlot();
    metrics.setServiceReplicaCount(UniqueServiceName, baseReplicaCount);
    metrics.setServiceCapacityPerReplica(UniqueServiceName, 10);
    metricsPerTimeSlotMap.set(timeSlotKey, metrics);
  });

  return { propagationResults, metricsPerTimeSlotMap };
}

async function scale(
  rpsPerSlot: number[],
  baseReplicaCount = 1,
  scaling?: { maxScaleStep?: number; maxReplicas?: number }
): Promise<number[]> {
  const { propagationResults, metricsPerTimeSlotMap } = mockTimeline(rpsPerSlot, baseReplicaCount);
  await (LoadSimulationHandler.getInstance() as any).applyAutoScalingForTimeSlot(
    propagationResults,
    mockServiceMetrics(scaling),
    metricsPerTimeSlotMap
  );
  return rpsPerSlot.map(
    (_, slotIndex) => metricsPerTimeSlotMap.get(`0-${slotIndex}-0`)!.getServiceReplicaCount(UniqueServiceName)
  );
}

describe("LoadSimulationHandler auto-scaling", () => {
  it("keeps the configured replica count in the first slot", async () => {
    // Slot 0 stays at 2 despite its own load; slot 1 is the first to see it.
    expect(await scale([999, 1], 2)).toEqual([2, 4]);
  });

  it("reacts to a spike one slot after it happens", async () => {
    // The spike is in slot 1, but slot 1 was already sized from slot 0's traffic.
    expect(await scale([1, 21, 1, 1])).toEqual([1, 1, 3, 1]);
  });

  it("ignores the traffic of the slot it is sizing", async () => {
    expect(await scale([1, 1, 1, 1])).toEqual([1, 1, 1, 1]);
    expect(await scale([1, 1, 1, 999])).toEqual([1, 1, 1, 1]);
  });

  it("limits each step to maxScaleStep", async () => {
    expect(await scale([999, 999, 999], 1, { maxScaleStep: 2 })).toEqual([1, 3, 5]);
  });

  it("never exceeds maxReplicas", async () => {
    expect(await scale([999, 999, 999, 999], 1, { maxReplicas: 4 })).toEqual([1, 3, 4, 4]);
  });

  it("scales back down once the load is gone", async () => {
    expect(await scale([50, 50, 0, 0, 0])).toEqual([1, 3, 5, 3, 1]);
  });
});
