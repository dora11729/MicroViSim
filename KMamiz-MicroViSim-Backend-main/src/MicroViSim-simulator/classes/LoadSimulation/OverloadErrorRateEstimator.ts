import {
  TEndpointPropagationStatsForOneTimeSlot,
} from "../../entities/TLoadSimulation";
import { TCMetricsPerTimeSlot } from "../../entities/TLoadSimulation";
import SimulatorUtils from "../SimulatorUtils";

export default class OverloadErrorRateEstimator {
  adjustedErrorRateByOverload(
    overloadErrorRateIncreaseFactor: number,
    propagationResultsWithBasicError: Map<string, Map<string, TEndpointPropagationStatsForOneTimeSlot>>,
    metricsPerTimeSlotMap: Map<string, TCMetricsPerTimeSlot>,
  ) {

    /*
      Estimate the expected traffic received by each service based on the results of the 
      "first time traffic propagation"(propagationResultsWithBasicError).
     */

    const serviceReceivedRequestCount = this.computeRequestCountsPerServicePerTimeSlot(propagationResultsWithBasicError);

    for (const [timeSlotKey, serviceCounts] of serviceReceivedRequestCount.entries()) {
      const metricsInThisTimeSlot = metricsPerTimeSlotMap.get(timeSlotKey);
      if (metricsInThisTimeSlot) {
        const errorRateMapThisSlot = metricsInThisTimeSlot.getEndpointErrorRateMap();

        for (const [uniqueEndpointName, baseErrorRate] of errorRateMapThisSlot.entries()) {
          const uniqueServiceName = SimulatorUtils.extractUniqueServiceNameFromEndpointName(uniqueEndpointName);

          // Get request count for the service in this hour
          const requestCountInThisHour = serviceCounts.get(uniqueServiceName) ?? 0;
          const requestCountPerSecond = requestCountInThisHour / 3600;

          const replicaCount = metricsInThisTimeSlot.getServiceReplicaCount(uniqueServiceName);
          const replicaMaxRPS = metricsInThisTimeSlot.getServiceCapacityPerReplica(uniqueServiceName);


          // console.log("----------")
          // console.log("timeSlotKey=", timeSlotKey)
          // console.log("uniqueEndpointName=", uniqueEndpointName)
          // console.log("requestCountInThisHour=", requestCountInThisHour)
          console.log(replicaMaxRPS)
          const adjustedErrorRate = this.estimateErrorRateWithServiceOverload({
            requestCountPerSecond,
            replicaCount,
            replicaMaxRPS,
            baseErrorRate,
            overloadErrorRateIncreaseFactor
          });

          metricsInThisTimeSlot.setEndpointErrorRate(uniqueEndpointName, adjustedErrorRate);
        }

      }
    }
  }

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

  private estimateErrorRateWithServiceOverload(data: {
    requestCountPerSecond: number,
    replicaCount: number,
    replicaMaxRPS: number,
    baseErrorRate: number,
    overloadErrorRateIncreaseFactor: number,
  }): number {
    const capacity = data.replicaCount * data.replicaMaxRPS; // Total system processing capacity (requests per second)

    if (capacity === 0) {
      // If there's no capacity, the service cannot handle any request.
      // Consider this as a full failure (100% error rate).
      return 1;
    }

    const utilization = data.requestCountPerSecond / capacity; // System utilization (load ratio)


    // console.log("requestCountPerSecond", data.requestCountPerSecond)
    // console.log(` replicas: ${data.replicaCount}`)
    // console.log(` capacity: ${capacity}`)
    // console.log(` utilization: ${utilization}`)
    if (utilization <= 1) {
      // When the system is not overloaded, the error rate remains at the baseline error rate.
      return data.baseErrorRate;
    }

    const overloadFactor = utilization - 1; // Overload ratio (the portion where utilization exceeds 1)

    // Additional error rate caused by overload, calculated using an exponential model.
    // (TODO)This is a temporary value; a more realistic error rate model applicable to real scenarios will be tested and applied in the future.
    const serviceOverloadErrorRate = 1 - Math.exp(-data.overloadErrorRateIncreaseFactor * overloadFactor); // E_overload

    // Total error rate E = E_basic + (1 - E_basic) × E_overload
    // where:
    // E_basic is the base error rate,
    // E_overload is the additional error rate caused by overload,
    // (1 - E_basic) represents the fraction of requests that were originally successful and can fail due to overload.
    const totalErrorRate = data.baseErrorRate + (1 - data.baseErrorRate) * serviceOverloadErrorRate;

    return Math.min(1, totalErrorRate);
  }

}