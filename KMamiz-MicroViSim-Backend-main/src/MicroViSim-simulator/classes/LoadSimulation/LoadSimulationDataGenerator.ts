import {
  TCombinedRealtimeData
} from "../../../entities/TCombinedRealtimeData";
import {
  TBaseDataWithResponses,
  TEndpointPropagationStatsForOneTimeSlot,
} from "../../entities/TLoadSimulation";

export default class LoadSimulationDataGenerator {

  generateRealtimeDataFromSimulationResults(
    baseDataMap: Map<string, TBaseDataWithResponses>,
    propagationFinalResults: Map<string, Map<string, TEndpointPropagationStatsForOneTimeSlot>>,
    simulateDate: number
  ): Map<string, TCombinedRealtimeData[]> {
    const realtimeDataPerTimeSlot = new Map<string, TCombinedRealtimeData[]>(); // key: timeSlotKey,format is"day-hour-minute"

    // console.log("generateRealtimeDataFromSimulationResults")
    // console.log("=== Propagation Final Results ===");

    // propagationFinalResults.forEach((innerMap, outerKey) => {
    //   console.log(` "${outerKey}"`);

    //   innerMap.forEach((stats, endpointKey) => {
    //     console.log(`  Endpoint: ${endpointKey}`);
    //     console.dir(stats, { depth: null }); // 展開 stats 的所有欄位
    //   });
    // });

    // console.log("=== baseDataMap ===");
    // baseDataMap.forEach((value, key) => {
    //   console.log(`Key: ${key}`);
    //   console.log(`  uniqueServiceName: ${value.baseData.uniqueServiceName}`);
    //   console.log(`  uniqueEndpointName: ${value.baseData.uniqueEndpointName}`);
    //   console.log(`  method: ${value.baseData.method}`);
    //   console.log(`  service: ${value.baseData.service}`);
    //   console.log(`  namespace: ${value.baseData.namespace}`);
    //   console.log(`  version: ${value.baseData.version}`);

    //   if (value.responses) {
    //     console.log(`  responses:`);
    //     console.dir(value.responses, { depth: null });
    //   }
    // });

    for (const [timeSlotKey, statsOnSpecificTimeSlot] of propagationFinalResults.entries()) {
      // timestamp
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
        const errorCount = stats.ownErrorCount + stats.downstreamErrorCount;
        const successCount = stats.requestCount - errorCount;
        if (successCount > 0) {

          const resp2xx = responses?.find(res => res.status.startsWith("2"));
          combinedList.push({
            ...baseData,
            latestTimestamp: timestampMicro,
            requestSchema: undefined,
            responseSchema: undefined,
            responseBody: resp2xx?.responseBody,
            responseContentType: resp2xx?.responseContentType,
            combined: successCount,
            status: resp2xx?.status ?? "200",
            latency: stats.latencyStatsByStatus.get("200") ?? { mean: 0, cv: 0 },
          });
        }

        if (errorCount > 0) {
          const resp5xx = responses?.find(res => res.status.startsWith("5"));
          combinedList.push({
            ...baseData,
            latestTimestamp: timestampMicro,
            requestSchema: undefined,
            responseSchema: undefined,
            responseBody: resp5xx?.responseBody,
            responseContentType: resp5xx?.responseContentType,
            combined: errorCount,
            status: resp5xx?.status ?? "500",
            latency: stats.latencyStatsByStatus.get("500") ?? { mean: 0, cv: 0 },
          });
        }
      }
      realtimeDataPerTimeSlot.set(timeSlotKey, combinedList);
    }
    return realtimeDataPerTimeSlot;
  }

}