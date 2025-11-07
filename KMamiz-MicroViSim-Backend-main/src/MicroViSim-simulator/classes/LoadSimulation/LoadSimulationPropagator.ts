import {
  TEndpointPropagationStatsForOneTimeSlot,
  TDependOnMapWithCallProbability,
} from "../../entities/TLoadSimulation";
import {
  TSimulationEndpointDelay
} from "../../entities/TSimConfigLoadSimulation";
import SimulatorUtils from "../SimulatorUtils";
import { TCMetricsPerTimeSlot, } from "../../entities/TLoadSimulation";
import { FallbackHandler } from "./FallbackHandler";
import { TSimulationEndpointMetric } from "../../entities/TSimConfigLoadSimulation";
export default class LoadSimulationPropagator {
  /*
    Explanation of NO_DEPENDENT_CALL:
      If the total call probability of a dependency group is less than 100%, 
      the remaining probability represents *not calling* any endpoint in that group (i.e., NO_DEPENDENT_CALL).
      This models cases where the upstream caller may skip calling any dependent endpoint under certain conditions.

      Example:
      dependOn:
        - oneOf:
          - endpointId: a-service-v1-get-user
            callProbability: 20
          - endpointId: a-service-v2-get-user
            callProbability: 40

      In this case, the total probability is 60%, 
      so there is a 40% chance that no endpoint in this group will be called (NO_DEPENDENT_CALL).
  */
  private static NO_DEPENDENT_CALL: string = "NO_DEPENDENT_CALL";

  simulatePropagation(
    endpointMetrics: TSimulationEndpointMetric[],
    dependOnMapWithCallProbability: TDependOnMapWithCallProbability,
    metricsPerTimeSlotMap: Map<string, TCMetricsPerTimeSlot>,
    shouldComputeLatency: boolean,
  ): Map<string, Map<string, TEndpointPropagationStatsForOneTimeSlot>> {
    /*
     * Returns a Map representing aggregated traffic simulation results.
     *
     * Top-level Map  :
     * Key:   string - A timeSlotKey in "day-hour-minute" format (e.g., "0-10-30").
     * Value: Map<string, TEndpointPropagationStats> - Details for all endpoints active during a specific time slot.
     *
     * Inner Map (Value of Top-level Map):
     * Key:   string - uniqueEndpointName
     * Value: TEndpointPropagationStats
     */
    const fallbackHandler = new FallbackHandler(endpointMetrics);
    const propagationResult: Map<string, Map<string, TEndpointPropagationStatsForOneTimeSlot>> = new Map();

    for (const [timeSlotKey, metricsInThisTimeSlot] of metricsPerTimeSlotMap.entries()) {
      const propagationResultAtThisTimeSlot = this.simulatePropagationInSingleTimeSlot(
        metricsInThisTimeSlot,
        dependOnMapWithCallProbability,
        fallbackHandler,
        shouldComputeLatency,
      )
      propagationResult.set(timeSlotKey, propagationResultAtThisTimeSlot);
    }

    return propagationResult;
  }

  private simulatePropagationInSingleTimeSlot(
    metricsInThisTimeSlot: TCMetricsPerTimeSlot,
    dependOnMapWithCallProbability: TDependOnMapWithCallProbability,
    fallbackHandler:FallbackHandler,
    shouldComputeLatency: boolean
  ): Map<string, TEndpointPropagationStatsForOneTimeSlot> {
     // key: uniqueEndpointName value: TEndpointPropagationStats for this endpoint
    const endpointStats = new Map<string, TEndpointPropagationStatsForOneTimeSlot>();


    // for compute latency CV(// Use Welford's algorithm to calculate CV and avoid overflow issues when computing variance)
    const onlineLatencyStats = new Map<string, Map<string, { count: number; mean: number; m2: number }>>();
    const updateOnlineStats = (stats: { count: number; mean: number; m2: number }, x: number) => {
      stats.count += 1;
      const delta = x - stats.mean;
      stats.mean += delta / stats.count;
      const delta2 = x - stats.mean;
      stats.m2 += delta * delta2;
    };

    // Track visited (endpoint::requestId) to avoid infinite recursion
    const visited = new Set<string>();

    // DFS to simulate errors and calculate actual latency for each request
    const dfsForPropagate = (
      uniqueEndpointName: string,
      requestIds: string[],
    ): { statusMap: Map<string, boolean>; latencyMap: Map<string, number> } => {

      const currentStatus = new Map<string, boolean>();
      const totalLatencyMap = new Map<string, number>();

      // Filter out requestIds that have already visited this endpoint
      const filteredRequestIds = requestIds.filter(reqId => {
        const key = `${uniqueEndpointName}::${reqId}`;
        if (visited.has(key)) return false;
        visited.add(key);
        return true;
      });
      if (filteredRequestIds.length === 0) {
        return { statusMap: currentStatus, latencyMap: totalLatencyMap };
      }


      const uniqueServiceName = SimulatorUtils.extractUniqueServiceNameFromEndpointName(uniqueEndpointName);
      const replicaCount = metricsInThisTimeSlot.getServiceReplicaCount(uniqueServiceName);

      // If a service has replica = 0, it always reports failure to upstream callers and does not propagate requests downstream.
      if (replicaCount === 0) {
        for (const reqId of filteredRequestIds) {
          // The endpoint itself always succeeds (not counted as ownError),
          // but reports a failure (false) to upstream,
          // and latency is treated as 0.
          currentStatus.set(reqId, false);
          totalLatencyMap.set(reqId, 0);
        }
        // Do not propagate to downstream dependencies
        return { statusMap: currentStatus, latencyMap: totalLatencyMap };
      }
      const errorRate = metricsInThisTimeSlot.getEndpointErrorRate(uniqueEndpointName);
      const delay: TSimulationEndpointDelay = metricsInThisTimeSlot.getEndpointDelay(uniqueEndpointName);

      // Simulate this endpointNode’s own error state
      const ownSuccessStatus = new Map<string, boolean>();
      for (const reqId of filteredRequestIds) {
        const isError = Math.random() < errorRate;
        ownSuccessStatus.set(reqId, !isError);
        currentStatus.set(reqId, !isError);
        const jitteredLatency = this.getJitteredLatency(delay.latencyMs, delay.jitterMs);
        totalLatencyMap.set(reqId, jitteredLatency); // Default latency starts with own latency
      }

      // Get dependent endpoints
      const dependentsGroups = dependOnMapWithCallProbability.get(uniqueEndpointName);

      if (dependentsGroups && dependentsGroups.length > 0) {
        // For each group, determine which endpoint to actually call
        // Map key: requestId, value: Map<groupIndex, selectedEndpointName>
        const selectedDependentsPerRequest = new Map<string, Map<number, string>>();

        for (const reqId of filteredRequestIds) {
          selectedDependentsPerRequest.set(reqId, new Map());
        }


        // For each dependent group, randomly select one endpoint based on call probability
        dependentsGroups.forEach((group, groupIdx) => {
          for (const reqId of filteredRequestIds) {
            const rand = Math.random() * 100;
            let cumulativeProb = 0;
            let selectedEndpoint = LoadSimulationPropagator.NO_DEPENDENT_CALL;

            for (const target of group) {
              cumulativeProb += target.callProbability;
              if (rand < cumulativeProb) {
                selectedEndpoint = target.targetEndpointUniqueEndpointName;
                break;
              }
            }
            selectedDependentsPerRequest.get(reqId)!.set(groupIdx, selectedEndpoint);
          }
        });

        // Call downstream endpoints based on selected endpoints (skip NO_DEPENDENT_CALL, treat as success, no latency added)
        // First, collect a set of unique selected endpoints per request to avoid duplicate calls
        const dependentCallsCache = new Map<string, { statusMap: Map<string, boolean>; latencyMap: Map<string, number> }>();

        // Identify which endpoints are actually called for each request (excluding NO_DEPENDENT_CALL)
        const requestIdToCalledEndpoints = new Map<string, Set<string>>();
        for (const reqId of filteredRequestIds) {
          const selectedMap = selectedDependentsPerRequest.get(reqId)!;
          const calledEndpoints = new Set<string>();
          for (const selectedEp of selectedMap.values()) {
            if (selectedEp !== LoadSimulationPropagator.NO_DEPENDENT_CALL) {
              calledEndpoints.add(selectedEp);
            }
          }
          requestIdToCalledEndpoints.set(reqId, calledEndpoints);
        }

        // Perform DFS for each endpoint (only for requests that actually invoke it)
        for (const group of dependentsGroups) {
          for (const target of group) {
            const epName = target.targetEndpointUniqueEndpointName;
            if (epName === LoadSimulationPropagator.NO_DEPENDENT_CALL) continue;

            // Filter requests that need to call this endpoint
            const reqsToCall = filteredRequestIds.filter(reqId => {
              return requestIdToCalledEndpoints.get(reqId)!.has(epName) &&
                currentStatus.get(reqId); //If the current endpoint fails on its own (currentStatus = false), it will not proceed to call downstream services.
            });
            if (reqsToCall.length > 0 && !dependentCallsCache.has(epName)) {

              dependentCallsCache.set(epName, dfsForPropagate(epName, reqsToCall));
            }
          }
        }

        // Finally, for each requestId, determine success and latency
        for (const reqId of filteredRequestIds) {
          if (!currentStatus.has(reqId)) continue;
          if (currentStatus.get(reqId) === false) continue; // Already failed, no need to check downstream

          const dependentSuccessList: boolean[] = [];
          let dependentLatencies: number[] = [];

          const selectedMap = selectedDependentsPerRequest.get(reqId)!;

          for (const selectedEp of selectedMap.values()) {
            if (selectedEp === LoadSimulationPropagator.NO_DEPENDENT_CALL) {
              // Treat NO_DEPENDENT_CALL as success and do not add latency
              dependentSuccessList.push(true);
              continue;
            }

            const depCallResult = dependentCallsCache.get(selectedEp);
            if (depCallResult && depCallResult.statusMap.has(reqId)) {
              dependentSuccessList.push(depCallResult.statusMap.get(reqId)!);
              dependentLatencies.push(depCallResult.latencyMap.get(reqId) ?? 0);
            } else {
              // Assume success by default, though this case shouldn't happen
              dependentSuccessList.push(true);
            }
          }

          const parentCurrentSuccess = currentStatus.get(reqId)!;
          const fallbackStrategy = fallbackHandler.getEndpointFallbackStrategy(uniqueEndpointName);
          const newParentSuccess = fallbackStrategy.propagateError(parentCurrentSuccess, dependentSuccessList);
          currentStatus.set(reqId, newParentSuccess);

          // Update latency (critical path)
          const ownLatency = totalLatencyMap.get(reqId) ?? 0;
          const maxDependentLatency = dependentLatencies.length > 0 ? Math.max(...dependentLatencies) : 0;

          if (ownSuccessStatus.get(reqId)) {
            totalLatencyMap.set(reqId, ownLatency + maxDependentLatency);
          } else {
            totalLatencyMap.set(reqId, ownLatency);
          }
        }
      }

      if (!onlineLatencyStats.has(uniqueEndpointName)) {
        onlineLatencyStats.set(uniqueEndpointName, new Map<string, { count: number; mean: number; m2: number }>());
      }
      const statMap = onlineLatencyStats.get(uniqueEndpointName)!;

      for (const reqId of filteredRequestIds) {
        const statusCode = currentStatus.get(reqId) ? "200" : "500";
        if (!statMap.has(statusCode)) {
          statMap.set(statusCode, { count: 0, mean: 0, m2: 0 });
        }
        updateOnlineStats(statMap.get(statusCode)!, totalLatencyMap.get(reqId)!);
      }

      // Count own errors and downstream errors
      let ownErrorCount = 0;
      let downstreamErrorCount = 0;
      for (const reqId of filteredRequestIds) {
        const ownSuccess = ownSuccessStatus.get(reqId) ?? false;
        const finalSuccess = currentStatus.get(reqId) ?? false;

        if (!ownSuccess) ownErrorCount++;
        else if (!finalSuccess) downstreamErrorCount++;
      }

      // Update endpointNode statistics
      const prevStats = endpointStats.get(uniqueEndpointName) ?? {
        requestCount: 0,
        ownErrorCount: 0,
        downstreamErrorCount: 0,
        latencyStatsByStatus: new Map<string, { mean: number; cv: number }>(),
      };
      endpointStats.set(uniqueEndpointName, {
        requestCount: prevStats.requestCount + filteredRequestIds.length,
        ownErrorCount: prevStats.ownErrorCount + ownErrorCount,
        downstreamErrorCount: prevStats.downstreamErrorCount + downstreamErrorCount,
        latencyStatsByStatus: prevStats.latencyStatsByStatus,
      });

      return { statusMap: currentStatus, latencyMap: totalLatencyMap };
    }


    // Execute simulation
    const entryPointRequestCountsMap = metricsInThisTimeSlot.getEntryPointRequestCountMap();
    for (const [entryPoint, count] of entryPointRequestCountsMap.entries()) {
      const requestIds = this.generateRequestIds(entryPoint, count);
      dfsForPropagate(entryPoint, requestIds);
    }

    for (const [uniqueEndpointName, statMap] of onlineLatencyStats.entries()) {
      const prevStats = endpointStats.get(uniqueEndpointName)!;
      const latencyStatsByStatus = new Map<string, { mean: number; cv: number }>();

      for (const [status, statsData] of statMap.entries()) {
        if (shouldComputeLatency && statsData.count > 0) {
          const variance = statsData.count > 1 ? statsData.m2 / (statsData.count - 1) : 0;
          const stdDev = Math.sqrt(variance);
          const cv = statsData.mean !== 0 ? stdDev / statsData.mean : 0;
          latencyStatsByStatus.set(status, { mean: statsData.mean, cv });
        } else {
          latencyStatsByStatus.set(status, { mean: 0, cv: 0 });
        }
      }

      endpointStats.set(uniqueEndpointName, {
        ...prevStats,
        latencyStatsByStatus,
      });
    }

    return endpointStats;
  }

  private getJitteredLatency(baseLatency: number, jitterMs: number): number {
    const min = baseLatency - jitterMs;
    const max = baseLatency + jitterMs;
    const jittered = Math.random() * (max - min) + min;
    return Math.max(0, jittered); // Ensure latency is not negative
  }

  // Generate request IDs, format: 'endpoint-0', 'endpoint-1' ...
  private generateRequestIds(uniqueEndpointName: string, count: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      ids.push(`${uniqueEndpointName}-${i}`);
    }
    return ids;
  }
}