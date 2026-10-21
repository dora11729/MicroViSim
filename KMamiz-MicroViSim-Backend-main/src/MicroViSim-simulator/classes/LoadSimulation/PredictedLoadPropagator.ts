import {
  TCMetricsPerTimeSlot,
  TDependOnMapWithCallProbability,
} from "../../entities/TLoadSimulation";
import SimulatorUtils from "../SimulatorUtils";

const SECONDS_PER_HOUR = 3600;

/*
  Why a model-scaled service got no prediction for a slot.
  insufficientHistory: its own model needs more past slots than exist yet.
  serviceUnavailable: the ML service failed to predict for it.
  noPredictionSource: no own model (no external traffic) and no predicted upstream.
*/
export type TMLFallbackReason = "insufficientHistory" | "serviceUnavailable" | "noPredictionSource";

export type TServiceTrafficProfile = {
  endpointDaily: Map<string, number>;       // uniqueEndpointName -> external daily requests
  serviceDaily: Map<string, number>;        // uniqueServiceName -> sum over its endpoints
  endpointsOfService: Map<string, string[]>;
};

export type TPredictedServiceLoad =
  | { status: "ok"; rps: number }
  | { status: "fallback"; reason: TMLFallbackReason };

type TCallEdge = { target: string; callRate: number };
type TEndpointLoad = { rps: number; predicted: boolean };

/*
  Expected per-slot load, propagated down the call graph:

    load_e(t)   = sum over entry endpoints i of visits_i(e) * external_i(t)
    external_i  = predicted external RPS of i's service * D_i / D_S, or observed at t-1
    visits_i(e) = sum over simple paths i -> ... -> e of the product of their call rates

  visits_i(e) is the simulator's expected number of calls e receives per request entering
  at i: a request is propagated along every path, but never re-enters an endpoint already
  on its path. It depends only on the call graph, so it is computed once.

  Demand only: unlike the simulator, a failing caller is still assumed to call on.
*/
export default class PredictedLoadPropagator {
  propagate(input: {
    sortedTimeSlotKeys: string[];
    profile: TServiceTrafficProfile;
    dependOnMap: TDependOnMapWithCallProbability;
    metricsPerTimeSlotMap: Map<string, TCMetricsPerTimeSlot>;
    // Per trained service, its predicted external RPS for every slot; null if the ML
    // service failed for it.
    ownPredictions: Map<string, (number | null)[] | null>;
    modelServices: string[];
  }): Map<string, Map<string, TPredictedServiceLoad>> {
    const { sortedTimeSlotKeys, profile, ownPredictions, modelServices } = input;
    const edges = this.buildCallEdges(input.dependOnMap);
    const entries = Array.from(profile.endpointDaily.entries())
      .filter(([, daily]) => daily > 0)
      .map(([entry]) => entry);
    const visitsPerEntry = new Map(entries.map(entry => [entry, this.visitsPerRequest(entry, edges)]));
    const table = new Map<string, Map<string, TPredictedServiceLoad>>();

    // Slot 0 has no observed past; the scaling loop never asks for it.
    for (let t = 1; t < sortedTimeSlotKeys.length; t++) {
      const previousMetrics = input.metricsPerTimeSlotMap.get(sortedTimeSlotKeys[t - 1]);
      const loads = new Map<string, TEndpointLoad>();

      for (const entry of entries) {
        const service = SimulatorUtils.extractUniqueServiceNameFromEndpointName(entry);
        const ownRPS = ownPredictions.get(service)?.[t];
        const external: TEndpointLoad = ownRPS != null
          ? { rps: ownRPS * profile.endpointDaily.get(entry)! / profile.serviceDaily.get(service)!, predicted: true }
          : { rps: (previousMetrics?.getEntryPointRequestCount(entry) ?? 0) / SECONDS_PER_HOUR, predicted: false };

        visitsPerEntry.get(entry)!.forEach((visits, endpoint) => {
          const load = loads.get(endpoint) ?? { rps: 0, predicted: false };
          loads.set(endpoint, { rps: load.rps + visits * external.rps, predicted: load.predicted || external.predicted });
        });
      }

      const slotTable = new Map<string, TPredictedServiceLoad>();
      for (const service of modelServices) {
        const serviceLoads = (profile.endpointsOfService.get(service) ?? [])
          .map(e => loads.get(e))
          .filter((l): l is TEndpointLoad => l !== undefined);
        slotTable.set(service, serviceLoads.some(l => l.predicted)
          ? { status: "ok", rps: serviceLoads.reduce((sum, l) => sum + l.rps, 0) }
          : { status: "fallback", reason: this.fallbackReason(service, ownPredictions) });
      }
      table.set(sortedTimeSlotKeys[t], slotTable);
    }
    return table;
  }

  // Probability that one call of the caller calls the target. Each group picks at most one
  // target and the simulator calls a target picked by several groups only once.
  private buildCallEdges(dependOnMap: TDependOnMapWithCallProbability): Map<string, TCallEdge[]> {
    const edges = new Map<string, TCallEdge[]>();
    for (const [caller, groups] of dependOnMap.entries()) {
      const missProbability = new Map<string, number>();
      for (const group of groups) {
        const groupRate = new Map<string, number>();
        for (const { targetEndpointUniqueEndpointName: target, callProbability } of group) {
          groupRate.set(target, (groupRate.get(target) ?? 0) + callProbability / 100);
        }
        groupRate.forEach((rate, target) =>
          missProbability.set(target, (missProbability.get(target) ?? 1) * (1 - Math.min(rate, 1))));
      }
      edges.set(caller, Array.from(missProbability.entries())
        .map(([target, miss]) => ({ target, callRate: 1 - miss }))
        .filter(edge => edge.callRate > 0));
    }
    return edges;
  }

  // Walks every simple path from the entry, as the simulator propagates one request.
  // 算入口請求到各個 endpoint 的訪問次數
  private visitsPerRequest(entry: string, edges: Map<string, TCallEdge[]>): Map<string, number> {
    const visits = new Map<string, number>();
    const onPath = new Set<string>();
    const walk = (endpoint: string, weight: number) => {
      visits.set(endpoint, (visits.get(endpoint) ?? 0) + weight);
      onPath.add(endpoint);
      for (const { target, callRate } of edges.get(endpoint) ?? []) {
        if (!onPath.has(target)) walk(target, weight * callRate);
      }
      onPath.delete(endpoint);
    };
    walk(entry, 1);
    return visits;
  }

  private fallbackReason(
    service: string,
    ownPredictions: Map<string, (number | null)[] | null>
  ): TMLFallbackReason {
    if (!ownPredictions.has(service)) return "noPredictionSource";
    return ownPredictions.get(service) === null ? "serviceUnavailable" : "insufficientHistory";
  }
}
