import {
  TSimulationNamespaceServiceMetrics,
  TSimulationEndpointMetric,
  TLoadSimulationSettings,
  TLoadSimulationConfig,
  TSimulationEndpointDelay,
  TSimulationTrafficPattern,
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
import { TMLFallbackReason } from "./PredictedLoadPropagator";
import PredictionAccuracyTracker from "./PredictionAccuracyTracker";
import SimulationRandom from "../SimulationRandom";

const SECONDS_PER_HOUR = 3600;

export default class LoadSimulationHandler {
  private static instance?: LoadSimulationHandler;
  static getInstance = () => this.instance || (this.instance = new this());

  private dataGenerator: LoadSimulationDataGenerator;
  private propagator: LoadSimulationPropagator;
  private faultInjector: FaultInjector;
  private overloadErrorRateAndLatencyEstimator: OverloadErrorRateAndLatencyEstimator;
  private mlScalingHandler: MLScalingHandler;
  private random: SimulationRandom;

  private constructor() {
    this.dataGenerator = new LoadSimulationDataGenerator();
    this.propagator = new LoadSimulationPropagator();
    this.faultInjector = new FaultInjector();
    this.overloadErrorRateAndLatencyEstimator = new OverloadErrorRateAndLatencyEstimator();
    this.mlScalingHandler = MLScalingHandler.getInstance();
    this.random = SimulationRandom.getInstance();
  }

  async generateCombinedRealtimeDataMap(
    loadSimulationSettings: TLoadSimulationSettings,
    dependOnMapWithCallProbability: TDependOnMapWithCallProbability,
    baseReplicaCountList: TReplicaCount[],
    EndpointRealTimeBaseDatas: Map<string, TBaseDataWithResponses>,
    simulateDate: number
  ): Promise<{
    realtimeCombinedDataPerTimeSlotMap: Map<string, TCombinedRealtimeData[]>;
    realtimeReplicaCountTimeline: Map<string, TReplicaCount[]>;
    metricsPerTimeSlotMap: Map<string, TCMetricsPerTimeSlot>
  }> {

    // Reseed before anything draws, so the whole run replays from this one number.
    const seed = this.random.reset(loadSimulationSettings.config.randomSeed);
    console.log(`[Simulation] random seed: ${seed}`);

    // Generate base metrics data for each service and endpoint from simulation config
    const metricsPerTimeSlotMap = this.generateBaseMetricsPerTimeSlotMap(
      loadSimulationSettings,
      baseReplicaCountList
    );

    // console.log("metricsPerTimeSlotMap origin", metricsPerTimeSlotMap);

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
      loadSimulationSettings,
      dependOnMapWithCallProbability,
      propagationResultsWithBasicError,
      metricsPerTimeSlotMap
    )

    const serviceReceivedRequestCount = this.computeRequestCountsPerServicePerTimeSlot(propagationResultsWithBasicError);

    /*
      Estimate overload level for each service based on expected incoming traffic, 
      the number of replicas, and per-replica throughput capacity. Then combine 
      with base error rate to calculate the adjusted error rate per endpoint, per timeSlot.
    */
    this.overloadErrorRateAndLatencyEstimator.adjustedErrorRateAndLatencyByOverload(
      loadSimulationSettings.config.overloadErrorRateIncreaseFactor,
      loadSimulationSettings.config.overloadLatencyIncreaseFactor,
      loadSimulationSettings.config.overloadLatencyAmplifier,
      // propagationResultsWithBasicError,
      serviceReceivedRequestCount,
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
      metricsPerTimeSlotMap,
      simulateDate
    );

    // Post-auto-scaling replica count per time slot, restricted to the slots that produced
    // realtime data so both maps stay aligned for downstream consumers.
    const realtimeReplicaCountTimeline = new Map<string, TReplicaCount[]>();

    for (const timeSlotKey of realtimeCombinedDataPerTimeSlotMap.keys()) {
      const metrics = metricsPerTimeSlotMap.get(timeSlotKey);
      if (!metrics) continue;

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
      realtimeReplicaCountTimeline: realtimeReplicaCountTimeline,
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
    const baseEndpointDelayMap = new Map<string, TSimulationEndpointDelay[]>();
    const baseEndpointMaxLatencyMap = new Map<string, number>();
    const baseEndpointTimeoutMsMap = new Map<string, number>();
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
      baseEndpointDelayMap.set(uniqueEndpointName, metric.delay);

      // EndpointMaxLatency
      baseEndpointMaxLatencyMap.set(uniqueEndpointName, metric.maxLatencyMs);

      // EndpointTimeout
      baseEndpointTimeoutMsMap.set(uniqueEndpointName, metric.timeoutMs);

      // EndpointErrorRate
      baseEndpointErrorRateMap.set(uniqueEndpointName,
        (metric.errorRatePercentage) / 100
      );

      // DailyRequestCount (distributed)
      const distributedDailyRequestCount: number[][] = this.distributeRequestCountsForSimulationDuration({
        expectedExternalDailyRequestCount: metric.expectedExternalDailyRequestCount,
        simulationDurationInDays,
        timeSlotCountPerDay,
        trafficPattern: loadSimulationConfig.trafficPattern,
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

        // EndpointMaxLatency
        metricsInThisTimeSlot.setEndpointMaxLatencyMap(baseEndpointMaxLatencyMap);

        // EndpointTimeout
        metricsInThisTimeSlot.setEndpointTimeoutMsMap(baseEndpointTimeoutMsMap);

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
      trafficPattern: TSimulationTrafficPattern,
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
      trafficPattern: TSimulationTrafficPattern,
    }

  ): number[] {

    /*
      Generate random weights for distributing request counts across all time slots  
      with flat: ±20%, unimodal, bimodal and custom: ±10% fluctuation.
      (TODO:後續可找幾篇論文研究真實流量波動範圍，然後調整此設計！！)
    */
    const FLAT_JITTER = 0.2;
    const SHAPED_JITTER = 0.1;
    
    const jitter = data.trafficPattern.shape === "flat" ? FLAT_JITTER : SHAPED_JITTER;
    const shapeWeights = this.buildShapeWeights(data.timeSlotCountPerDay, data.trafficPattern);
    const weights = shapeWeights.map(shapeWeight => {
      return shapeWeight * (1 + (this.random.next() * 2 * jitter - jitter));
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
    Relative busyness of each slot within a day, quietest slot always weighing 1 and the
    busiest peakRatio.
      unimodal => one broad peak at peakHour, bottoming out twelve hours later
      bimodal => two peaks (peakHour and secondPeakHour), e.g. a commute pattern
      custom => hourlyMultipliers as given, 0 for the hours it leaves out
  */
  private buildShapeWeights(
    timeSlotCountPerDay: number,
    trafficPattern: TSimulationTrafficPattern
  ): number[] {
    const { shape, peakHour, secondPeakHour, peakRatio } = trafficPattern;

    if (shape === "flat") {
      return new Array(timeSlotCountPerDay).fill(1);
    }

    if (shape === "custom") {
      const multipliers = trafficPattern.hourlyMultipliers ?? [];
      return Array.from({ length: timeSlotCountPerDay }, (_, slot) => multipliers[slot] ?? 0);
    }

    if (shape === "bimodal") {
      return this.buildBimodalWeights(timeSlotCountPerDay, peakHour, secondPeakHour, peakRatio);
    }

    return Array.from({ length: timeSlotCountPerDay }, (_, slot) => {
      const phase = (2 * Math.PI * (slot - peakHour)) / timeSlotCountPerDay;
      return 1 + (peakRatio - 1) * 0.5 * (1 + Math.cos(phase));
    });
  }

  /*
    Two bell curves, one per peak, combined by taking whichever is nearer so both peaks
    reach peakRatio regardless of how far apart they sit. Their width scales with the
    separation, which keeps the dip between them visible even for closely spaced peaks.
  */
  private buildBimodalWeights(
    timeSlotCountPerDay: number,
    peakHour: number,
    secondPeakHour: number,
    peakRatio: number
  ): number[] {
    const separation = this.hoursApart(peakHour, secondPeakHour, timeSlotCountPerDay);
    const width = Math.max(separation / 3.5, 0.5);

    const bump = (slot: number, peak: number) =>
      Math.exp(-0.5 * (this.hoursApart(slot, peak, timeSlotCountPerDay) / width) ** 2);

    const raw = Array.from({ length: timeSlotCountPerDay }, (_, slot) =>
      Math.max(bump(slot, peakHour), bump(slot, secondPeakHour))
    );

    // Rescale so the quietest slot lands on 1 and the busiest on peakRatio.
    const quietest = Math.min(...raw);
    const busiest = Math.max(...raw);
    const span = busiest - quietest;
    return raw.map(value =>
      span === 0 ? 1 : 1 + (peakRatio - 1) * ((value - quietest) / span)
    );
  }

  // Distance between two slots taking the shorter way round the clock.
  private hoursApart(a: number, b: number, timeSlotCountPerDay: number): number {
    const direct = Math.abs(a - b) % timeSlotCountPerDay;
    return Math.min(direct, timeSlotCountPerDay - direct);
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

      no model => reactive HPA, the naive "next RPS = last RPS"
      model    => predicted RPS: the service's own share-of-day model plus whatever
                  predicted load its callers pass down (MLScalingHandler)
  */
  private async applyAutoScalingForTimeSlot(
    loadSimulationSettings: TLoadSimulationSettings,
    dependOnMapWithCallProbability: TDependOnMapWithCallProbability,
    propagationResultsWithBasicError: Map<string, Map<string, TEndpointPropagationStatsForOneTimeSlot>>,
    metricsPerTimeSlotMap: Map<string, TCMetricsPerTimeSlot>,
  ) {
    const serviceMetrics = loadSimulationSettings.serviceMetrics;
    const serviceReceivedRequestCount = this.computeRequestCountsPerServicePerTimeSlot(propagationResultsWithBasicError);
    const sortedTimeSlotKeys = Array.from(metricsPerTimeSlotMap.keys()).sort(
      (a, b) => this.timeSlotKeyToMinutes(a) - this.timeSlotKeyToMinutes(b)
    );

    const predictedLoads = await this.mlScalingHandler.planPredictedLoads({
      serviceMetrics,
      endpointMetrics: loadSimulationSettings.endpointMetrics,
      dependOnMap: dependOnMapWithCallProbability,
      metricsPerTimeSlotMap,
      sortedTimeSlotKeys,
    });

    // ns: namespace
    const dataset = [];

    // evaluate RPS: actual V.S. predicted V.S. naive (last RPS)
    const accuracyTracker = new PredictionAccuracyTracker();

    // Map<uniqueServiceName, Map<TMLFallbackReason, counts>>
    // ML prediction failed record
    const fallbackCounts = new Map<string, Map<TMLFallbackReason, number>>();

    for (const ns of serviceMetrics) {
      for (const svc of ns.services) {
        for (const ver of svc.versions) {
          if (!ver.uniqueServiceName || !ver.autoScaling) continue;

          // 有開 autoScaling
          // model: null => 只有 threshold 決定是否 scale (簡易 HPA 邏輯)
          // model: not null => 用 ML model (arima, bilstm, gru) 預測的 RPS 決定是否 scale
          const uniqueServiceName = ver.uniqueServiceName;
          const model = ver.autoScaling.model ?? null;
          const { targetUtilization, tolerance, maxScaleStep, maxReplicas } = ver.autoScaling;
          let lastReplicaCount: number | null = null;

          for (let slotIndex = 0; slotIndex < sortedTimeSlotKeys.length; slotIndex++) {
            const timeSlotKey = sortedTimeSlotKeys[slotIndex];
            const metricsInThisTimeSlot = metricsPerTimeSlotMap.get(timeSlotKey);
            if (!metricsInThisTimeSlot) continue;

            const baseReplicaCount = metricsInThisTimeSlot.getServiceReplicaCount(uniqueServiceName);
            const currentReplicaCount = lastReplicaCount ?? baseReplicaCount;
            const replicaMaxRPS = metricsInThisTimeSlot.getServiceCapacityPerReplica(uniqueServiceName);

            // Ground truth for this slot: only the dataset may use it.
            const actualRequestCountPerSecond =
              (serviceReceivedRequestCount.get(timeSlotKey)?.get(uniqueServiceName) ?? 0) / SECONDS_PER_HOUR;

            const lastTimeSlotKey = sortedTimeSlotKeys[slotIndex - 1];
            if (lastTimeSlotKey === undefined) {
              lastReplicaCount = baseReplicaCount;
              dataset.push({
                timeSlotKey,
                service: uniqueServiceName,
                requestCountPerSecond: actualRequestCountPerSecond,
                replicaCount: baseReplicaCount,
                replicaMaxRPS,
              });
              continue;
            }

            const lastRequestCountPerSecond =
              (serviceReceivedRequestCount.get(lastTimeSlotKey)?.get(uniqueServiceName) ?? 0) / SECONDS_PER_HOUR;

            // default to the naive predictor (last RPS) if no model is specified or if the model fails
            let predictedRequestCountPerSecond = lastRequestCountPerSecond;

            if (model !== null) {
              const predictedLoad = predictedLoads.get(timeSlotKey)?.get(uniqueServiceName);
              if (predictedLoad?.status === "ok") {
                predictedRequestCountPerSecond = predictedLoad.rps;
              } else {
                this.recordFallback(fallbackCounts, uniqueServiceName,
                  predictedLoad?.status === "fallback" ? predictedLoad.reason : "noPredictionSource");
              }
            }

            accuracyTracker.record(uniqueServiceName, model, {
              actual: actualRequestCountPerSecond,
              predicted: predictedRequestCountPerSecond,
              naive: lastRequestCountPerSecond,
            });

            const desireReplicas = this.computeDesiredReplicas(
              predictedRequestCountPerSecond,
              currentReplicaCount,
              replicaMaxRPS,
              targetUtilization,
              tolerance
            );

            // console.log(`[Auto-scaling] ${uniqueServiceName} at ${timeSlotKey}: RPS=${requestCountPerSecond.toFixed(2)}, smoothed RPS=${smoothedRPS.toFixed(2)}, desiredReplicas=${desireReplicas}, currentReplicas=${lastReplicaCount}`);

            // 把值限制在[min, max]區間內
            // make sure it doesn't exceed maxReplicas and at least 1
            const finalDesired = Math.min(
              Math.max(desireReplicas, currentReplicaCount - maxScaleStep, 1),  // scale down 上界(lowerBound)
              currentReplicaCount + maxScaleStep,                               // scale up 上界(upperBound)
              maxReplicas
            );

            const diffFromBase = finalDesired - baseReplicaCount;
            if (diffFromBase > 0) { // scale up
              metricsInThisTimeSlot.addServiceReplicaCount(uniqueServiceName, diffFromBase);
            } else if (diffFromBase < 0) {  // scale down
              metricsInThisTimeSlot.subtractServiceReplicaCount(uniqueServiceName, -diffFromBase);
            }


            // ------------------------------------------------
            const scaledReplicaCount = metricsInThisTimeSlot.getServiceReplicaCount(uniqueServiceName);
            dataset.push({
              timeSlotKey,
              service: uniqueServiceName,
              requestCountPerSecond: actualRequestCountPerSecond,
              replicaCount: scaledReplicaCount,
              replicaMaxRPS
            });
            lastReplicaCount = scaledReplicaCount;
            // ------------------------------------------------

          }
        }
      }
    }

    accuracyTracker.report();
    this.reportMLFallbacks(fallbackCounts);
    console.dir(dataset, { depth: null, maxArrayLength: null });
  }

  private recordFallback(
    fallbackCounts: Map<string, Map<TMLFallbackReason, number>>,
    uniqueServiceName: string,
    reason: TMLFallbackReason
  ) {
    if (!fallbackCounts.has(uniqueServiceName)) {
      fallbackCounts.set(uniqueServiceName, new Map());
    }
    const reasonCounts = fallbackCounts.get(uniqueServiceName)!;
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }

  // A fallback slot is indistinguishable from reactive scaling, so a run with many of
  // them is not really measuring the model. Surface the counts rather than hide them.
  private reportMLFallbacks(
    fallbackCounts: Map<string, Map<TMLFallbackReason, number>>
  ) {
    for (const [uniqueServiceName, reasonCounts] of fallbackCounts.entries()) {
      const breakdown = Array.from(reasonCounts.entries())
        .map(([reason, count]) => `${reason}=${count}`)
        .join(", ");
      console.warn(
        `[Auto-scaling] ${uniqueServiceName}: fell back to last RPS in some time slots (${breakdown})`
      );
    }
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


  private computeDesiredReplicas(
    requestCountPerSecond: number,
    currentReplicas: number,
    replicaMaxRPS: number,
    targetUtilization: number,
    tolerance: number = 0.1     // 容忍區間
  ): number {
    if (replicaMaxRPS === 0 || currentReplicas === 0) return 1;

    const utilization = requestCountPerSecond / (replicaMaxRPS * currentReplicas);
    const desiredReplicas = Math.ceil(
      requestCountPerSecond / (replicaMaxRPS * targetUtilization)
    );

    // 只有在超出 tolerance 範圍才動作（避免微小抖動觸發 scaling）
    const ratio = utilization / targetUtilization;

    if (ratio > 1 + tolerance || (currentReplicas > 1 && ratio < 1 - tolerance)) {
      return desiredReplicas;
    }

    return currentReplicas;
  }

  private timeSlotKeyToMinutes(timeSlotKey: string): number {
    const [day, hour, minute] = timeSlotKey.split("-").map(Number);
    return day * 24 * 60 + hour * 60 + minute;
  }
}