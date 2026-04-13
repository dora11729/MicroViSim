import {
  TSimulationNamespaceServiceMetrics,
  TSimulationEndpointMetric,
  TLoadSimulationSettings,
  TLoadSimulationConfig,
  TSimulationEndpointDelay,
} from "../../entities/TSimConfigLoadSimulation";
import {
  TBaseDataWithResponses,
  TDependOnMapWithCallProbability,
  TEndpointPropagationStatsForOneTimeSlot
} from "../../entities/TLoadSimulation";
import { TCMetricsPerTimeSlot } from "../../entities/TLoadSimulation";
import { TReplicaCount } from "../../../entities/TReplicaCount";
import { TCombinedRealtimeData } from "../../../entities/TCombinedRealtimeData";

import LoadSimulationDataGenerator from "./LoadSimulationDataGenerator";
import LoadSimulationPropagator from "./LoadSimulationPropagator";
import FaultInjector from "./FaultInjector";
import OverloadErrorRateAndLatencyEstimator from "./OverloadErrorRateAndLatencyEstimator";
import SimulatorUtils from "../SimulatorUtils";
import MLScalingHandler from "./MLScalingHandler";

export default class LoadSimulationHandler {
  private static instance?: LoadSimulationHandler;
  static getInstance = () => this.instance || (this.instance = new this());

  private dataGenerator: LoadSimulationDataGenerator;
  private propagator: LoadSimulationPropagator;
  private faultInjector: FaultInjector;
  private overloadErrorRateAndLatencyEstimator: OverloadErrorRateAndLatencyEstimator;
  private mlScalingHandler: MLScalingHandler;

  private constructor() {
    this.dataGenerator = new LoadSimulationDataGenerator();
    this.propagator = new LoadSimulationPropagator();
    this.faultInjector = new FaultInjector();
    this.overloadErrorRateAndLatencyEstimator = new OverloadErrorRateAndLatencyEstimator();
    this.mlScalingHandler = MLScalingHandler.getInstance();
  }

  async generateCombinedRealtimeDataMap(
    loadSimulationSettings: TLoadSimulationSettings,
    dependOnMapWithCallProbability: TDependOnMapWithCallProbability,
    baseReplicaCountList: TReplicaCount[],
    EndpointRealTimeBaseDatas: Map<string, TBaseDataWithResponses>,
    simulateDate: number
  ): Promise<{
    realtimeCombinedDataPerTimeSlotMap: Map<string, TCombinedRealtimeData[]>;
    metricsPerTimeSlotMap: Map<string, TCMetricsPerTimeSlot>
  }> {

    // Generate base metrics data for each service and endpoint from simulation config
    const metricsPerTimeSlotMap = this.generateBaseMetricsPerTimeSlotMap(
      loadSimulationSettings,
      baseReplicaCountList
    );

    // console.log("metricsPerTimeSlotMap origin", metricsPerTimeSlotMap);

    // collect replica timeline
    const replicaTimeline: {
      timeSlot: string;
      replicas: Record<string, number>;
    }[] = [];
    for (const [timeSlotKey, metricsInThisTimeSlot] of metricsPerTimeSlotMap.entries()) {
      replicaTimeline.push({
        timeSlot: timeSlotKey,
        replicas: Object.fromEntries(metricsInThisTimeSlot.getServiceReplicaCountMap())
      });
    }


    /*
      Inject faults before traffic propagation to ensure that both propagations 
      encounter the same fault conditions. This ensures that the estimated 
      service load after the first propagation is accurate.
    */
    this.faultInjector.injectFault(
      loadSimulationSettings,
      metricsPerTimeSlotMap
    );

    /* 
      Use the base error rate to simulate traffic propagation and calculate the 
      expected incoming traffic for each service under normal (non-overloaded) 
      conditions.
    */
    const propagationResultsWithBasicError = this.propagator.simulatePropagation(
      loadSimulationSettings.endpointMetrics,
      dependOnMapWithCallProbability,
      metricsPerTimeSlotMap,
      false
    );

    // Apply auto-scaling decisions based on basic error rate propagation
    await this.applyAutoScalingForTimeSlot(
      propagationResultsWithBasicError,
      loadSimulationSettings.serviceMetrics,
      metricsPerTimeSlotMap
    )


    /*
      Estimate overload level for each service based on expected incoming traffic, 
      the number of replicas, and per-replica throughput capacity. Then combine 
      with base error rate to calculate the adjusted error rate per endpoint, per timeSlot.
    */
    this.overloadErrorRateAndLatencyEstimator.adjustedErrorRateAndLatencyByOverload(
      loadSimulationSettings.config.overloadErrorRateIncreaseFactor,
      loadSimulationSettings.config.overloadLatencyIncreaseFactor,
      loadSimulationSettings.config.overloadLatencyAmplifier,
      propagationResultsWithBasicError,
      metricsPerTimeSlotMap
    )


    // console.log("metricsPerTimeSlotMap after AdjustedErrorRateByOverload", metricsPerTimeSlotMap);

    // Re-run traffic propagation with adjusted error rates  
    // to obtain actual traffic distribution considering both "base errors" and "overload-induced errors"
    const propagationResultsWithOverloadError = this.propagator.simulatePropagation(
      loadSimulationSettings.endpointMetrics,
      dependOnMapWithCallProbability,
      metricsPerTimeSlotMap,
      true,
    );

    const realtimeCombinedDataPerTimeSlotMap: Map<string, TCombinedRealtimeData[]> = this.dataGenerator.generateRealtimeDataFromSimulationResults(
      EndpointRealTimeBaseDatas,
      propagationResultsWithOverloadError,
      simulateDate
    );

    const realtimeReplicaCountTimeline = new Map<string, TReplicaCount[]>();

    for (const [timeSlotKey, metrics] of metricsPerTimeSlotMap.entries()) {
      const replicaList: TReplicaCount[] = baseReplicaCountList.map(svc => ({
        uniqueServiceName: svc.uniqueServiceName,
        service: svc.service,
        namespace: svc.namespace,
        version: svc.version,
        replicas: metrics.getServiceReplicaCount(svc.uniqueServiceName)
      }));
      realtimeReplicaCountTimeline.set(timeSlotKey, replicaList);
    }


    return {
      realtimeCombinedDataPerTimeSlotMap: realtimeCombinedDataPerTimeSlotMap,
      metricsPerTimeSlotMap: metricsPerTimeSlotMap,
    };
  }

  private generateBaseMetricsPerTimeSlotMap(
    loadSimulationSettings: TLoadSimulationSettings,
    baseServiceReplicaCountList: TReplicaCount[],
  ): Map<string, TCMetricsPerTimeSlot> {
    /**
     * return type:
     *  key: A string representing the time slot (e.g., "day-hour-minute")
     *  value: An instance of BaseMetricsPerTimeSlot containing aggregated metrics for that time slot
     */

    // loadSimulation settings
    const serviceMetrics: TSimulationNamespaceServiceMetrics[] = loadSimulationSettings.serviceMetrics;
    const endpointMetrics: TSimulationEndpointMetric[] = loadSimulationSettings.endpointMetrics;
    const loadSimulationConfig: TLoadSimulationConfig = loadSimulationSettings.config;
    const simulationDurationInDays = loadSimulationConfig.simulationDurationInDays;

    // initial return data
    const metricsPerTimeSlotMap = new Map<string, TCMetricsPerTimeSlot>();
    for (let day = 0; day < simulationDurationInDays; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const timeSlotKey = `${day}-${hour}-0`;
        metricsPerTimeSlotMap.set(timeSlotKey, new TCMetricsPerTimeSlot());
      }
    }

    // Early return if there is no traffic
    if (!endpointMetrics) {
      return metricsPerTimeSlotMap;
    }

    // construct base data maps from simulation config
    const baseEndpointDelayMap = new Map<string, TSimulationEndpointDelay>();
    const baseEndpointErrorRateMap = new Map<string, number>();
    const baseEndpointSimulationReqCountsMap = new Map<string, number[][]>();
    const baseServiceReplicaCountMap = new Map<string, number>(
      baseServiceReplicaCountList.map(item => [item.uniqueServiceName, item.replicas])
    )
    const baseServiceCapacityPerReplicaMap = new Map<string, number>();
    const timeSlotCountPerDay = 24 // Time granularity is hourly (i.e., 24 intervals per day)
    for (const metric of endpointMetrics) {
      const uniqueEndpointName = metric.uniqueEndpointName!;

      // EndpointDelay
      baseEndpointDelayMap.set(uniqueEndpointName, {
        latencyMs: metric.delay.latencyMs,
        jitterMs: metric.delay.jitterMs
      });

      // EndpointErrorRate
      baseEndpointErrorRateMap.set(uniqueEndpointName,
        (metric.errorRatePercent) / 100
      );

      // DailyRequestCount (distributed)
      const distributedDailyRequestCount: number[][] = this.distributeRequestCountsForSimulationDuration({
        expectedExternalDailyRequestCount: metric.expectedExternalDailyRequestCount,
        simulationDurationInDays,
        timeSlotCountPerDay,
      });
      baseEndpointSimulationReqCountsMap.set(uniqueEndpointName,
        distributedDailyRequestCount
      )

    }

    const transformedBaseEndpointDailyReqCounts = this.transformEndpointSimulationReqCountsMap({
      baseEndpointSimulationReqCountsMap,
      simulationDurationInDays,
      timeSlotCountPerDay
    });
    for (const ns of serviceMetrics) {
      for (const svc of ns.services) {
        for (const ver of svc.versions) {
          if (ver.uniqueServiceName) {
            baseServiceCapacityPerReplicaMap.set(ver.uniqueServiceName, ver.capacityPerReplica);
          }
        }
      }
    }

    // Update information in BaseMetricsPerTimeSlotMap using base data maps
    for (let day = 0; day < simulationDurationInDays; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const timeSlotKey = `${day}-${hour}-0`;
        const metricsInThisTimeSlot = metricsPerTimeSlotMap.get(timeSlotKey)!;

        // EndpointDelay
        metricsInThisTimeSlot.setEndpointDelayMap(baseEndpointDelayMap);

        // EndpointErrorRate
        metricsInThisTimeSlot.setEndpointErrorRateMap(baseEndpointErrorRateMap);

        // DailyRequestCount (distributed)
        metricsInThisTimeSlot.setEntryPointRequestCountMap(transformedBaseEndpointDailyReqCounts[day][hour]);

        // ServiceReplicaCount
        metricsInThisTimeSlot.setServiceReplicaCountMap(baseServiceReplicaCountMap);

        // ServiceCapacityPerReplica
        metricsInThisTimeSlot.setServiceCapacityPerReplicaMap(baseServiceCapacityPerReplicaMap);

      }
    }

    return metricsPerTimeSlotMap;
  }

  // Randomly distribute the  daily request count
  private distributeRequestCountsForSimulationDuration(
    data: {
      expectedExternalDailyRequestCount: number,
      simulationDurationInDays: number
      timeSlotCountPerDay: number,
    }
  ): number[][] {
    const result: number[][] = [];
    const { simulationDurationInDays, ...otherParams } = data;

    for (let day = 0; day < data.simulationDurationInDays; day++) {
      const dailyDistribution = this.distributeDailyRequestCount(
        otherParams
      );
      result.push(dailyDistribution);
    }

    return result;
  }
  private distributeDailyRequestCount(
    data: {
      expectedExternalDailyRequestCount: number,
      timeSlotCountPerDay: number,
    }

  ): number[] {

    /*
      Generate random weights for distributing request counts across all time slots  
      with ±20% fluctuation.
      (TODO:後續可找幾篇論文研究真實流量波動範圍，然後調整此設計！！)
    */
    const weights = Array.from({ length: data.timeSlotCountPerDay }, () => {
      return 1 + (Math.random() * 0.4 - 0.2); // 範圍：0.8 ~ 1.2
    });
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    const normalizedWeights = weights.map(w => w / totalWeight);

    // Multiply weights by total request count and floor the result to initially distribute requests
    const distributedDailyRequestCount = normalizedWeights.map(w => Math.floor(w * data.expectedExternalDailyRequestCount));

    // Calculate the difference that needs to be fixed
    let diff = data.expectedExternalDailyRequestCount - distributedDailyRequestCount.reduce((a, b) => a + b, 0);

    // Add the errors back sequentially to the time slots in descending order of their weights, 
    // ensuring that the total number of requests matches the original total.
    if (diff >= 1) {
      const sortedIndices = normalizedWeights
        .map((w, idx) => ({ idx, weight: w }))
        .sort((a, b) => b.weight - a.weight)
        .map(entry => entry.idx);

      let i = 0;
      while (diff >= 1) {
        const index = sortedIndices[i % data.timeSlotCountPerDay];
        distributedDailyRequestCount[index]++;
        diff--;
        i++;
      }
    }
    return distributedDailyRequestCount;
  }

  /*
    Transforms the simulation request counts map (endpoint → 2D [days][timeSlots] array) 
    into a 2D array of Maps indexed by [day][timeSlot], where each Map stores endpoint → count.
    (for easier construction of BaseMetricsPerTimeSlotMap)
  */
  private transformEndpointSimulationReqCountsMap(
    data: {
      baseEndpointSimulationReqCountsMap: Map<string, number[][]>,
      simulationDurationInDays: number,
      timeSlotCountPerDay: number
    }
  ): Array<Array<Map<string, number>>> {
    // Create the result structure: days x timeSlots
    const result: Array<Array<Map<string, number>>> = [];

    for (let day = 0; day < data.simulationDurationInDays; day++) {
      const daySlots: Array<Map<string, number>> = [];
      for (let slot = 0; slot < data.timeSlotCountPerDay; slot++) {
        daySlots.push(new Map<string, number>());
      }
      result.push(daySlots);
    }

    // Fill the structure: [day][slot] → Map<endpoint, count>
    for (const [endpoint, dailyCounts] of data.baseEndpointSimulationReqCountsMap.entries()) {
      for (let day = 0; day < data.simulationDurationInDays; day++) {
        const countsForThisDay = dailyCounts[day] || [];

        for (let slot = 0; slot < data.timeSlotCountPerDay; slot++) {
          const count = countsForThisDay[slot] ?? 0;
          result[day][slot].set(endpoint, count);
        }
      }
    }

    return result;
  }

  /*
    判斷service是否開啟autoScaling，有的話判斷是否進行scale
     grater than scaleUPThreshold => 產能不足
     less than scaleDownThreshold => 產能太足
  */
  private async applyAutoScalingForTimeSlot(
    propagationResultsWithBasicError: Map<string, Map<string, TEndpointPropagationStatsForOneTimeSlot>>,
    serviceMetrics: TSimulationNamespaceServiceMetrics[],
    metricsPerTimeSlotMap: Map<string, TCMetricsPerTimeSlot>,
  ) {
    const serviceReceivedRequestCount = this.computeRequestCountsPerServicePerTimeSlot(propagationResultsWithBasicError);
    const sortedTimeSlotKeys = Array.from(metricsPerTimeSlotMap.keys()).sort(
      (a, b) => this.timeSlotKeyToMinutes(a) - this.timeSlotKeyToMinutes(b)
    );

    // ns: namespace
    const dataset = [];
    for (const ns of serviceMetrics) {
      for (const svc of ns.services) {
        for (const ver of svc.versions) {
          if (!ver.uniqueServiceName || !ver.autoScaling) continue;

          // 有開 autoScaling
          // model: null => 只有 threshold 決定是否 scale (簡易 HPA 邏輯)
          // model: not null => ML bodel (xgboost, random_forest, lstm) 預測下一個時間點的 request count，再決定是否 scale
          const uniqueServiceName = ver.uniqueServiceName;
          const model = ver.autoScaling.model ?? null;
          const { scaleUpThreshold, scaleDownThreshold, maxScaleCounts } = ver.autoScaling;

          for (const timeSlotKey of sortedTimeSlotKeys) {
            const metricsInThisTimeSlot = metricsPerTimeSlotMap.get(timeSlotKey);
            const serviceCounts = serviceReceivedRequestCount.get(timeSlotKey);
            if (!metricsInThisTimeSlot || !serviceCounts) continue;

            // Get request count for the service in this hour
            const requestCountInThisHour = serviceCounts.get(uniqueServiceName) ?? 0;
            var requestCountPerSecond = requestCountInThisHour / 3600;

            var replicaCount = metricsInThisTimeSlot.getServiceReplicaCount(uniqueServiceName);
            const replicaMaxRPS = metricsInThisTimeSlot.getServiceCapacityPerReplica(uniqueServiceName);

            /*
            console.log("----------")
            console.log("timeSlotKey=", timeSlotKey)
            console.log("uniqueServiceName=", uniqueServiceName)
            console.log("requestCountPerSecond=", requestCountPerSecond)
            console.log("replicaCount=", replicaCount)
            console.log("replicaMaxRPS=", replicaMaxRPS)
            console.log("maxScaleCounts=", maxScaleCounts)
            */

            // use ML model to predict RPS as requestCountPerSecond
            if (model !== null) {
              const history = model === "lstm"
                ? this.mlScalingHandler.buildHistoryWindow(
                  uniqueServiceName,
                  timeSlotKey,
                  sortedTimeSlotKeys,
                  serviceReceivedRequestCount,
                  metricsPerTimeSlotMap
                )
                : undefined;

              const predictedRPS = await this.mlScalingHandler.predictNextRPS(
                model,
                { replicaCount, requestCountPerSecond, replicaMaxRPS },
                history ?? undefined
              );

              if (predictedRPS !== null) {
                console.log(`[ML:${model}] `, uniqueServiceName, ` ${timeSlotKey}: original RPS: ${requestCountPerSecond}, predicted: ${predictedRPS}`);
                
                requestCountPerSecond = predictedRPS;
              }
            }

            const desireReplicas = this.computeDesiredReplicas(
              requestCountPerSecond,
              replicaCount,
              replicaMaxRPS,
              scaleUpThreshold,
              scaleDownThreshold
            );

            // null => 不用動
            if (desireReplicas !== null) {
              const diffReplicas = desireReplicas - replicaCount;
              if (diffReplicas > 0) {
                metricsInThisTimeSlot.addServiceReplicaCount(uniqueServiceName, Math.min(maxScaleCounts, diffReplicas));
              } else if (diffReplicas < 0) {
                // at least leave 1
                const finalDiff = Math.min(maxScaleCounts, -diffReplicas, replicaCount - 1);
                if (finalDiff > 0) {
                  metricsInThisTimeSlot.subtractServiceReplicaCount(uniqueServiceName, finalDiff)
                }
              }
            }

            // ------------------------------------------------
            replicaCount = metricsInThisTimeSlot.getServiceReplicaCount(uniqueServiceName);
            dataset.push({
              timeSlotKey,
              service: uniqueServiceName,
              requestCountPerSecond,
              replicaCount,
              replicaMaxRPS
            });
            // ------------------------------------------------

          }
        }
      }
    }
    console.dir(dataset, { depth: null, maxArrayLength: null });

  }


  // copy from OverloadErrorRateEstimator
  private computeRequestCountsPerServicePerTimeSlot(
    propagationResultsWithBasicError: Map<string, Map<string, TEndpointPropagationStatsForOneTimeSlot>>
  ): Map<string, Map<string, number>> {
    /*
     * This Map aggregates the total request counts for each service at specific time intervals.
     *
     * Top-level Map:
     * Key:   string - A time slot key in "day-hour-minute" format (e.g., "0-10-30"), representing the start of a specific time interval.
     * Value: Map<string, number> - Total request counts for each service during this time interval.
     *
     * Inner Map (Value of Top-level Map):
     * Key:   string - uniqueServiceName.
     * Value: number - The aggregated request count for that specific service during the time interval.
     */

    // Used to store the final statistical results. The key is the timestamp and the value 
    // is the number of requests for each service at that timestamp.
    const serviceRequestCountsPerTimeSlot = new Map<string, Map<string, number>>();

    for (const [timeSlotKey, timeSlotStats] of propagationResultsWithBasicError.entries()) {

      if (!serviceRequestCountsPerTimeSlot.has(timeSlotKey)) {
        serviceRequestCountsPerTimeSlot.set(timeSlotKey, new Map());
      }

      // Retrieve the map of services and their request counts for the current time slot
      const serviceMap = serviceRequestCountsPerTimeSlot.get(timeSlotKey)!;

      // timeSlotStats contains statistics for all endpoints during this time slot
      for (const [uniqueEndpointName, stats] of timeSlotStats.entries()) {
        // Extract the service ID from the endpoint ID
        const uniqueServiceName = SimulatorUtils.extractUniqueServiceNameFromEndpointName(uniqueEndpointName);

        // Get the current aggregated count for this service, defaulting to 0 if none exists
        const prevCount = serviceMap.get(uniqueServiceName) || 0;

        // Add the current endpoint's request count to the service's total count
        serviceMap.set(uniqueServiceName, prevCount + stats.requestCount);
      }
    }

    return serviceRequestCountsPerTimeSlot;
  }


  // return desiredReplicas
  // 之後test好 可以再整理一下(刪掉註解)
  private computeDesiredReplicas(
    requestCountPerSecond: number,
    replicaCount: number,
    replicaMaxRPS: number,
    scaleUpThreshold: number,
    scaleDownThreshold: number
  ): number | null {

    // denominator(分母) = 0 => threshold= NaN
    if (replicaMaxRPS == 0 || replicaCount == 0) {
      //console.log("threshold= NaN, scaleUpThreshold=", scaleUpThreshold, ", scaleDownThreshold=", scaleDownThreshold)
      return null;
    }

    const threshold = requestCountPerSecond / (replicaMaxRPS * replicaCount);
    const thresholdPerReplica = requestCountPerSecond / replicaMaxRPS

    //console.log("threshold=", threshold, ", scaleUpThreshold=", scaleUpThreshold, ", scaleDownThreshold=", scaleDownThreshold)

    // desiredReplicas: 剛剛好 高過scaleUpThreshold 或 低過scaleDownThreshold 的replica數
    if (threshold > scaleUpThreshold) {
      const desiredReplicas = Math.ceil(thresholdPerReplica / scaleUpThreshold);
      //console.log("Rule addServiceReplicaCount: desiredReplicas=", desiredReplicas)

      return desiredReplicas;
      /*
      if (diffReplicas > 0) {
        metricsInThisTimeSlot.addServiceReplicaCount(uniqueServiceName, Math.min(maxScaleCounts, diffReplicas));
      }
        */
    } else if (replicaCount > 1 && threshold < scaleDownThreshold) {
      const desiredReplicas = Math.ceil(thresholdPerReplica / scaleDownThreshold)
      //console.log("Rule subtractServiceReplicaCount: desiredReplicas=", desiredReplicas)

      return desiredReplicas;
      /*
      if (diffReplicas > 0) {
        diffReplicas = Math.min(diffReplicas, maxScaleCounts);

        // at least leave 1
        const finalDiff = Math.min(diffReplicas, replicaCount - 1);
        if (finalDiff > 0) {
          metricsInThisTimeSlot.subtractServiceReplicaCount(uniqueServiceName, Math.min(maxScaleCounts, diffReplicas))
        }
      }
        */
    }

    return null;
  }

  private timeSlotKeyToMinutes(timeSlotKey: string): number {
    const [day, hour, minute] = timeSlotKey.split("-").map(Number);
    return day * 24 * 60 + hour * 60 + minute;
  }
}