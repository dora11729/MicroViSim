import {
  TCombinedRealtimeData
} from "../../../entities/TCombinedRealtimeData";
import {
  TCMetricsPerTimeSlot,
  TBaseDataWithResponses,
  TEndpointPropagationStatsForOneTimeSlot,
} from "../../entities/TLoadSimulation";

const SIMULATION_BUCKET_DURATION_SECONDS = 3600;

export default class LoadSimulationDataGenerator {

  generateRealtimeDataFromSimulationResults(
    baseDataMap: Map<string, TBaseDataWithResponses>,
    propagationFinalResults: Map<string, Map<string, TEndpointPropagationStatsForOneTimeSlot>>,
    metricsPerTimeSlotMap: Map<string, TCMetricsPerTimeSlot>,
    simulateDate: number
  ): Map<string, TCombinedRealtimeData[]> {
    const realtimeDataPerTimeSlot = new Map<string, TCombinedRealtimeData[]>();

    for (const [timeSlotKey, statsOnSpecificTimeSlot] of propagationFinalResults.entries()) {
      const metricsInThisTimeSlot = metricsPerTimeSlotMap.get(timeSlotKey);
      const [dayStr, hourStr, minuteStr] = timeSlotKey.split('-');
      const day = parseInt(dayStr);
      const hour = parseInt(hourStr);
      const minute = parseInt(minuteStr);
      const dayMillis = simulateDate + day * 86400_000;
      const hourMillis = dayMillis + hour * 3600_000;
      const timestampMicro = (hourMillis + minute * 60_000) * 1000;

      const combinedList: TCombinedRealtimeData[] = [];
      for (const [uniqueEndpointName, stats] of statsOnSpecificTimeSlot.entries()) {
        const baseDataWithResp = baseDataMap.get(uniqueEndpointName);
        if (!baseDataWithResp) continue;

        const { baseData, responses } = baseDataWithResp;
        const uniqueServiceName = baseData.uniqueServiceName;
        const capacityPerReplica = metricsInThisTimeSlot?.getServiceCapacityPerReplica(uniqueServiceName) ?? 0;
        const errorCount = stats.ownErrorCount + stats.downstreamErrorCount;
        const successCount = stats.requestCount - errorCount;

        const sharedFields = {
          ...baseData,
          latestTimestamp: timestampMicro,
          requestSchema: undefined,
          responseSchema: undefined,
          capacityPerReplica,
          bucketDurationSeconds: SIMULATION_BUCKET_DURATION_SECONDS,
        };

        if (successCount > 0) {
          const resp2xx = responses?.find(res => res.status.startsWith("2"));
          combinedList.push({
            ...sharedFields,
            responseBody: resp2xx?.responseBody,
            responseContentType: resp2xx?.responseContentType,
            combined: successCount,
            status: resp2xx?.status ?? "200",
            latency: stats.latencyStatsByStatus.get("200") ?? { mean: 0, cv: 0, p95: 0 },
            ownLatency: stats.ownLatencyStatsByStatus.get("200") ?? { mean: 0, cv: 0, p95: 0 },
          });
        }

        if (errorCount > 0) {
          const resp5xx = responses?.find(res => res.status.startsWith("5"));
          combinedList.push({
            ...sharedFields,
            responseBody: resp5xx?.responseBody,
            responseContentType: resp5xx?.responseContentType,
            combined: errorCount,
            status: resp5xx?.status ?? "500",
            latency: stats.latencyStatsByStatus.get("500") ?? { mean: 0, cv: 0, p95: 0 },
            ownLatency: stats.ownLatencyStatsByStatus.get("500") ?? { mean: 0, cv: 0, p95: 0 },
          });
        }
      }
      realtimeDataPerTimeSlot.set(timeSlotKey, combinedList);
    }
    return realtimeDataPerTimeSlot;
  }

}
