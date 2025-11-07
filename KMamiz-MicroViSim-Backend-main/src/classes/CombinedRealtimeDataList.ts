import { TCombinedRealtimeData } from "../entities/TCombinedRealtimeData";
import { TEndpointDataType } from "../entities/TEndpointDataType";
import {
  THistoricalData,
  THistoricalEndpointInfo,
  THistoricalServiceInfo,
} from "../entities/THistoricalData";
import { TReplicaCount } from "../entities/TReplicaCount";
import { TRequestTypeUpper } from "../entities/TRequestType";
import { TRiskResult } from "../entities/TRiskResult";
import { TServiceDependency } from "../entities/TServiceDependency";
import RiskAnalyzer from "../utils/RiskAnalyzer";
import Utils from "../utils/Utils";
import EndpointDataType from "./EndpointDataType";

export default class CombinedRealtimeDataList {
  private readonly _combinedRealtimeData: TCombinedRealtimeData[];
  constructor(combinedRealtimeData: TCombinedRealtimeData[]) {
    this._combinedRealtimeData = combinedRealtimeData;
  }

  toJSON() {
    return this._combinedRealtimeData;
  }

  toHistoricalData(
    serviceDependencies: TServiceDependency[],
    replicas: TReplicaCount[] = [],
    labelMap?: Map<string, string>,
    belongsToFunc = (ts: number) => Utils.BelongsToMinuteTimestamp(ts)
  ) {
    const dateMapping = new Map<number, TCombinedRealtimeData[]>();
    this._combinedRealtimeData.forEach((r) => {
      const time = belongsToFunc(r.latestTimestamp / 1000);
      dateMapping.set(time, (dateMapping.get(time) || []).concat([r]));
    });

    return [...dateMapping.entries()].map(
      ([time, dailyData]): THistoricalData => {
        const risks = RiskAnalyzer.RealtimeRisk(
          dailyData,
          serviceDependencies,
          replicas
        );
        const endpointMap = new Map<string, TCombinedRealtimeData[]>();
        const serviceMap = new Map<string, TCombinedRealtimeData[]>();
        dailyData.forEach((r) => {
          endpointMap.set(
            r.uniqueEndpointName,
            (endpointMap.get(r.uniqueEndpointName) || []).concat([r])
          );
          serviceMap.set(
            r.uniqueServiceName,
            (serviceMap.get(r.uniqueServiceName) || []).concat([r])
          );
        });
        const allEndpoints = this.createHistoricalEndpointInfo(
          endpointMap,
          labelMap
        );
        return {
          date: new Date(time),
          services: this.createHistoricalServiceInfo(
            time,
            serviceMap,
            allEndpoints,
            risks
          ),
        };
      }
    );
  }
  private createHistoricalEndpointInfo(
    endpointMap: Map<string, TCombinedRealtimeData[]>,
    labelMap?: Map<string, string>
  ) {
    return [...endpointMap.entries()].map(
      ([uniqueEndpointName, r]): THistoricalEndpointInfo => {
        const [service, namespace, version, method] =
          uniqueEndpointName.split("\t");
        const { requests, requestErrors, serverErrors } = r.reduce(
          (prev, curr) => {
            const add = curr.combined;
            prev.requests += add;
            if (curr.status.startsWith("4")) prev.requestErrors += add;
            if (curr.status.startsWith("5")) prev.serverErrors += add;
            return prev;
          },
          { requests: 0, requestErrors: 0, serverErrors: 0 }
        );
        const validLatencies = r.filter(rl => rl.latency.mean !== undefined && rl.latency.mean !== null);
        const meanLatency = validLatencies.reduce((sum, rl) => sum + rl.latency.mean, 0) / validLatencies.length;

        return {
          latencyMean: (typeof (meanLatency) === "number" && isFinite(meanLatency)) ? meanLatency : 0,
          latencyCV: Math.max(...r.map((rl) => rl.latency.cv || 0)),
          method: method as TRequestTypeUpper,
          requestErrors,
          requests,
          serverErrors,
          uniqueEndpointName,
          uniqueServiceName: `${service}\t${namespace}\t${version}`,
          labelName: labelMap?.get(uniqueEndpointName),
        };
      }
    );
  }
  private createHistoricalServiceInfo(
    time: number,
    serviceMap: Map<string, TCombinedRealtimeData[]>,
    allEndpoints: THistoricalEndpointInfo[],
    risks: TRiskResult[]
  ) {
    return [...serviceMap.entries()].map(
      ([uniqueServiceName, r]): THistoricalServiceInfo => {
        const [service, namespace, version] = uniqueServiceName.split("\t");
        const endpoints = allEndpoints.filter(
          (e) => e.uniqueServiceName === uniqueServiceName
        );
        const { requests, requestErrors, serverErrors } = endpoints.reduce(
          (prev, curr) => {
            prev.requestErrors += curr.requestErrors;
            prev.serverErrors += curr.serverErrors;
            prev.requests += curr.requests;
            return prev;
          },
          { requests: 0, requestErrors: 0, serverErrors: 0 }
        );
        const validLatencies = r.filter(rl => typeof (rl.latency.mean) === "number" && isFinite(rl.latency.mean));
        const meanLatency = validLatencies.reduce((sum, rl) => sum + rl.latency.mean, 0) / validLatencies.length;

        return {
          date: new Date(time),
          endpoints,
          service,
          namespace,
          version,
          requests,
          requestErrors,
          serverErrors,
          latencyMean: (typeof (meanLatency) === "number" && isFinite(meanLatency)) ? meanLatency : 0,
          latencyCV: Math.max(...r.map((rl) => rl.latency.cv || 0)),
          uniqueServiceName,
          risk: risks.find(
            (rsk) => rsk.uniqueServiceName === uniqueServiceName
          )!.norm,
        };
      }
    );
  }

  extractEndpointDataType(labelMap?: Map<string, string>) {
    return this._combinedRealtimeData
      .map((r): TEndpointDataType => {
        const tokens = r.uniqueEndpointName.split("\t");
        const requestParams = Utils.GetParamsFromUrl(tokens[tokens.length - 1]);
        return {
          service: r.service,
          namespace: r.namespace,
          method: r.method,
          version: r.version,
          uniqueEndpointName: r.uniqueEndpointName,
          uniqueServiceName: r.uniqueServiceName,
          labelName: labelMap?.get(r.uniqueEndpointName),
          schemas: [
            {
              status: r.status,
              time: new Date(r.latestTimestamp / 1000),
              requestContentType: r.requestContentType,
              requestSample: r.requestBody,
              requestSchema: r.requestSchema,
              responseContentType: r.responseContentType,
              responseSample: r.responseBody,
              responseSchema: r.responseSchema,
              requestParams,
            },
          ],
        };
      })
      .map((e) => new EndpointDataType(e));
  }

  combineWith(rlData: CombinedRealtimeDataList) {
    const uniqueNameMap = new Map<string, TCombinedRealtimeData[]>();
    this._combinedRealtimeData
      .concat(rlData._combinedRealtimeData)
      .forEach((r) => {
        const id = `${r.uniqueEndpointName}\t${r.status}`;
        uniqueNameMap.set(id, (uniqueNameMap.get(id) || []).concat([r]));
      });

    const combined = [...uniqueNameMap.values()].map(
      (group): TCombinedRealtimeData => {
        const sample = group[0];
        const baseSample = {
          uniqueEndpointName: sample.uniqueEndpointName,
          uniqueServiceName: sample.uniqueServiceName,
          service: sample.service,
          namespace: sample.namespace,
          version: sample.version,
          method: sample.method,
          status: sample.status,
          combined: group.reduce((prev, curr) => prev + curr.combined, 0),
          requestContentType: sample.requestContentType,
          responseContentType: sample.responseContentType,
        };

        const combined = group.reduce((prev, curr) => {
          if (prev.avgReplica && curr.avgReplica)
            prev.avgReplica += curr.avgReplica;
          prev.latestTimestamp = Math.max(
            prev.latestTimestamp,
            curr.latestTimestamp
          );

          prev.requestBody = Utils.Merge(prev.requestBody, curr.requestBody);
          prev.responseBody = Utils.Merge(prev.responseBody, curr.responseBody);

          if (prev.requestBody) {
            prev.requestSchema = Utils.ObjectToInterfaceString(
              prev.requestBody
            );
          }
          if (prev.responseBody) {
            prev.responseSchema = Utils.ObjectToInterfaceString(
              prev.responseBody
            );
          }
          return prev;
        });

        const mergedLatency = group.reduce(
          (acc, curr) => {
            return {
              ...this.combineLatencyCVAndMean(acc.n, acc.mean, acc.cv,
                curr.combined, curr.latency.mean, curr.latency.cv),
              n: acc.n + curr.combined,
            };
          },
          {
            mean: 0,
            cv: 0,
            n: 0,
          }
        );

        return {
          ...baseSample,
          latestTimestamp: combined.latestTimestamp,
          requestBody: combined.requestBody,
          requestSchema: combined.requestSchema,
          responseBody: combined.responseBody,
          responseSchema: combined.responseSchema,
          latency: {
            mean: Utils.ToPrecise(mergedLatency.mean),
            cv: Utils.ToPrecise(mergedLatency.cv),
          },
        };
      }
    );

    return new CombinedRealtimeDataList(combined);
  }

  getContainingNamespaces() {
    return new Set(this._combinedRealtimeData.map((r) => r.namespace));
  }

  adjustTimestamp(to: number) {
    return new CombinedRealtimeDataList(
      this._combinedRealtimeData.map((rl) => ({
        ...rl,
        latestTimestamp: to * 1000,
      }))
    );
  }

  private combineLatencyCVAndMean(
    n1: number, mean1: number, cv1: number,
    n2: number, mean2: number, cv2: number
  ): { mean: number, cv: number } {

    /*
      To avoid overflow or floating point precision issues when calculating CV,
      temporarily scale the values to similar magnitudes
    */
    const shift = this.getScaleShift(mean1, mean2);
    const scale = Math.pow(10, shift);

    const mean1s = mean1 / scale;
    const mean2s = mean2 / scale;
    const std1s = cv1 * mean1s;
    const std2s = cv2 * mean2s;

    const totalN = n1 + n2;
    const meanTotal = (n1 * mean1s + n2 * mean2s) / totalN;

    const variance1 = std1s ** 2;
    const variance2 = std2s ** 2;

    //Merge variants
    const pooledVariance =
      (n1 * variance1 +
        n2 * variance2 +
        n1 * (mean1s - meanTotal) ** 2 +
        n2 * (mean2s - meanTotal) ** 2) / totalN;

    const stdTotal = Math.sqrt(pooledVariance);
    const cvTotal = meanTotal === 0 ? 0 : stdTotal / meanTotal;

    return {
      mean: meanTotal * scale,
      cv: cvTotal,
    };
  }

  /* 
    Get the average logarithmic scale (base 10) of two mean values
    This is used to scale both values to a similar order of magnitude,
    reducing overflow or floating point precision errors
  */
  private getScaleShift(mean1: number, mean2: number): number {
    const safeLog10 = (x: number) => {
      if (x <= 0) return 0;
      return Math.floor(Math.log10(x));
    };

    const exp1 = safeLog10(mean1);
    const exp2 = safeLog10(mean2);

    return Math.floor((exp1 + exp2) / 2);
  }
}
