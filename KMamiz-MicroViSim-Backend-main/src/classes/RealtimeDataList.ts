import Utils from "../utils/Utils";
import { TRealtimeData } from "../entities/TRealtimeData";
import { TCombinedRealtimeData } from "../entities/TCombinedRealtimeData";
import Logger from "../utils/Logger";
import CombinedRealtimeDataList from "./CombinedRealtimeDataList";

export class RealtimeDataList {
  private readonly _realtimeData: TRealtimeData[];
  constructor(realtimeData: TRealtimeData[]) {
    this._realtimeData = realtimeData;
  }

  toJSON() {
    return this._realtimeData;
  }

  getContainingNamespaces() {
    return new Set(this._realtimeData.map((r) => r.namespace));
  }


  toCombinedRealtimeData() {
    const uniqueNameMapping = new Map<string, TRealtimeData[]>();
    this._realtimeData.forEach((r) => {
      const id = r.uniqueEndpointName;
      uniqueNameMapping.set(id, (uniqueNameMapping.get(id) || []).concat([r]));
    });

    const combined = [...uniqueNameMapping.values()]
      .map((group): TCombinedRealtimeData[] => {
        const statusMap = new Map<string, TRealtimeData[]>();
        group.forEach((r) => {
          statusMap.set(r.status, (statusMap.get(r.status) || []).concat([r]));
        });
        const sample = group[0];
        const baseSample = {
          uniqueServiceName: sample.uniqueServiceName,
          uniqueEndpointName: sample.uniqueEndpointName,
          service: sample.service,
          namespace: sample.namespace,
          version: sample.version,
          method: sample.method,
        };

        const combinedSubGroup = [...statusMap.entries()].map(
          ([status, subGroup]): TCombinedRealtimeData => {

            const latencies = subGroup.map((r) => r.latency);

            const { mean, cv } = this.computeMeanAndCVByWelford(latencies);


            const combined = subGroup.reduce((prev, curr) => {
              const acc = { ...prev };
              acc.requestBody = Utils.MergeStringBody(
                acc.requestBody,
                curr.requestBody
              );
              acc.responseBody = Utils.MergeStringBody(
                acc.responseBody,
                curr.responseBody
              );
              acc.timestamp =
                acc.timestamp > curr.timestamp ? acc.timestamp : curr.timestamp;
              if (acc.replica && curr.replica) acc.replica += curr.replica;
              return acc;
            });
            const { requestBody, requestSchema, responseBody, responseSchema } =
              RealtimeDataList.parseRequestResponseBody(combined);

            return {
              ...baseSample,
              status,
              combined: subGroup.length,
              requestBody,
              requestSchema,
              responseBody,
              responseSchema,
              avgReplica: combined.replica
                ? combined.replica / subGroup.length
                : undefined,
              latestTimestamp: combined.timestamp,
              latency: {
                mean: Utils.ToPrecise(mean),
                cv: Utils.ToPrecise(cv),
              },
              requestContentType: combined.requestContentType,
              responseContentType: combined.responseContentType,
            };
          }
        );
        return combinedSubGroup;
      })
      .flat();

    return new CombinedRealtimeDataList(combined);
  }

  // Use Welford's algorithm to calculate CV and avoid overflow issues when computing variance
  private computeMeanAndCVByWelford(latencies: number[]): { mean: number, cv: number } {
    if (latencies.length === 0) return { mean: 0, cv: 0 };

    let mean = 0;
    let sumSqDiff = 0;

    for (let i = 0; i < latencies.length; i++) {
      const x = latencies[i];
      const oldMean = mean;
      mean += (x - mean) / (i + 1);
      sumSqDiff += (x - mean) * (x - oldMean);
    }

    const variance = sumSqDiff / latencies.length;
    const stdDev = Math.sqrt(variance);
    const cv = mean !== 0 ? stdDev / mean : 0;

    return { mean, cv };
  }

  static parseRequestResponseBody(data: Partial<TRealtimeData>): {
    requestBody?: unknown;
    requestSchema?: string;
    responseBody?: unknown;
    responseSchema?: string;
  } {
    const result: {
      requestBody?: unknown;
      requestSchema?: string;
      responseBody?: unknown;
      responseSchema?: string;
    } = {};

    if (data.requestContentType === "application/json") {
      try {
        result.requestBody = JSON.parse(data.requestBody!);
        result.requestSchema = Utils.ObjectToInterfaceString(
          result.requestBody
        );
      } catch (e) {
        Logger.verbose(`Not a JSON, skipping: [${data.requestBody}]`);
        result.requestBody = result.requestSchema = undefined;
      }
    }
    if (data.responseContentType === "application/json") {
      try {
        result.responseBody = JSON.parse(data.responseBody!);
        result.responseSchema = Utils.ObjectToInterfaceString(
          result.responseBody
        );
      } catch (e) {
        Logger.verbose(`Not a JSON, skipping: [${data.responseBody}]`);
        result.responseBody = result.responseSchema = undefined;
      }
    }
    return result;
  }
}
