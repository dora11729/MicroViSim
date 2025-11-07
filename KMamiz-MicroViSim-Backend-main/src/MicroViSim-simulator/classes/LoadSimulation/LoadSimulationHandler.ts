import {
  TSimulationNamespaceServiceMetrics,
  TSimulationEndpointMetric,
  TLoadSimulationSettings,
  TLoadSimulationConfig,
  TSimulationEndpointDelay,
} from "../../entities/TSimConfigLoadSimulation";
import {
  TBaseDataWithResponses,
  TDependOnMapWithCallProbability
} from "../../entities/TLoadSimulation";
import { TCMetricsPerTimeSlot } from "../../entities/TLoadSimulation";
import { TReplicaCount } from "../../../entities/TReplicaCount";
import { TCombinedRealtimeData } from "../../../entities/TCombinedRealtimeData";

import LoadSimulationDataGenerator from "./LoadSimulationDataGenerator";
import LoadSimulationPropagator from "./LoadSimulationPropagator";
import FaultInjector from "./FaultInjector";
import OverloadErrorRateEstimator from "./OverloadErrorRateEstimator";

export default class LoadSimulationHandler {
  private static instance?: LoadSimulationHandler;
  static getInstance = () => this.instance || (this.instance = new this());

  private dataGenerator: LoadSimulationDataGenerator;
  private propagator: LoadSimulationPropagator;
  private faultInjector: FaultInjector;
  private overloadErrorRateEstimator: OverloadErrorRateEstimator;

  private constructor() {
    this.dataGenerator = new LoadSimulationDataGenerator();
    this.propagator = new LoadSimulationPropagator();
    this.faultInjector = new FaultInjector();
    this.overloadErrorRateEstimator = new OverloadErrorRateEstimator();
  }

  generateCombinedRealtimeDataMap(
    loadSimulationSettings: TLoadSimulationSettings,
    dependOnMapWithCallProbability: TDependOnMapWithCallProbability,
    baseReplicaCountList: TReplicaCount[],
    EndpointRealTimeBaseDatas: Map<string, TBaseDataWithResponses>,
    simulateDate: number
  ): Map<string, TCombinedRealtimeData[]> {

    // Generate base metrics data for each service and endpoint from 
    // simulation config
    const metricsPerTimeSlotMap = this.generateBaseMetricsPerTimeSlotMap(
      loadSimulationSettings,
      baseReplicaCountList
    );

    // console.log("metricsPerTimeSlotMap origin", metricsPerTimeSlotMap);

    /*
      Inject faults before traffic propagation to ensure that both propagations 
      encounter the same fault conditions.(This is to ensure that the estimated 
      service load after the first propagation is accurate.)
    */
    this.faultInjector.injectFault(
      loadSimulationSettings,
      metricsPerTimeSlotMap
    );

    // console.log("metricsPerTimeSlotMap after faultInjector", metricsPerTimeSlotMap);

    /* 
      Use the base error rate to simulate traffic propagation and calculate the 
      expected incoming traffic for each service under normal (non-overloaded) 
      conditions propagationResultsWithBasicError: 
      Map<
        Key: "day-hour-minute", 
        Value: Map<
          key: uniqueEndpointName, 
          value:requestCount
        >
      >
    */
    const propagationResultsWithBasicError = this.propagator.simulatePropagation(
      loadSimulationSettings.endpointMetrics,
      dependOnMapWithCallProbability,
      metricsPerTimeSlotMap,
      false
    );

    /*
      Estimate overload level for each service based on expected incoming traffic, the number of replicas, and per-replica throughput capacity  
      Then combine with base error rate to calculate the adjusted error rate per endpoint, per timeSlot
    */
    this.overloadErrorRateEstimator.adjustedErrorRateByOverload(
      loadSimulationSettings.config.overloadErrorRateIncreaseFactor,
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

    // console.log("propagationResultsWithOverloadError", propagationResultsWithOverloadError)

    // console.log("propagationResultsWithOverloadError =")
    // for (const [timeKey, endpointMap] of propagationResultsWithOverloadError.entries()) {
    //   console.log(`Time: ${timeKey}`);
    //   for (const [uniqueEndpointName, stats] of endpointMap.entries()) {
    //     console.log(`  Endpoint: ${uniqueEndpointName}`);
    //     console.log(`    requestCount: ${stats.requestCount}`);
    //     console.log(`    ownErrorCount: ${stats.ownErrorCount}`);
    //     console.log(`    downstreamErrorCount: ${stats.downstreamErrorCount}`);
    //     console.log(`    latencyStatsByStatus:`);
    //     for (const [status, latencyStats] of stats.latencyStatsByStatus.entries()) {
    //       console.log(`      Status ${status}: mean=${latencyStats.mean}, cv=${latencyStats.cv}`);
    //     }
    //   }
    // }
    // console.log("end propagationResultsWithOverloadError  ==================")

    const realtimeCombinedDataPerTimeSlotMap: Map<string, TCombinedRealtimeData[]> = this.dataGenerator.generateRealtimeDataFromSimulationResults(
      EndpointRealTimeBaseDatas,
      propagationResultsWithOverloadError,
      simulateDate
    );
    return realtimeCombinedDataPerTimeSlotMap;
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

}