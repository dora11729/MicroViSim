import { TLoadSimulationSettings } from "../../entities/TSimConfigLoadSimulation";
import { TCMetricsPerTimeSlot } from "../../entities/TLoadSimulation";
export default class FaultInjector {

  injectFault(
    loadSimulationSettings: TLoadSimulationSettings,
    metricsPerTimeSlotMap: Map<string, TCMetricsPerTimeSlot>
  ) {
    // Get all endpoint and service fault records per time slot from settings
    const { allEndpointFaultRecords, allServiceFaultRecords } = this.generateAllFaultRecords(loadSimulationSettings);

    printNestedFaultRecords(allEndpointFaultRecords, true);
    printNestedFaultRecords(allServiceFaultRecords, false);

    for (const [timeSlotKey, metricsInThisTimeSlot] of metricsPerTimeSlotMap.entries()) {

      // Endpoint-level faults
      const endpointFaultRecordInThisTime = allEndpointFaultRecords.get(timeSlotKey);
      if (endpointFaultRecordInThisTime) {
        for (const [uniqueEndpointName, EndpointFaultObj] of endpointFaultRecordInThisTime.entries()) {

          // Fault increases the base latency of the endpoint
          if (EndpointFaultObj.getIncreaseLatency() > 0) {
            metricsInThisTimeSlot.addEndpointDelay(
              uniqueEndpointName,
              { latencyMs: EndpointFaultObj.getIncreaseLatency(), jitterMs: 0 }
            )
          }

          // Fault increases the endpoint error rate
          if (EndpointFaultObj.getIncreaseErrorRatePercent() > 0) {
            metricsInThisTimeSlot.addEndpointErrorRate(
              uniqueEndpointName,
              EndpointFaultObj.getIncreaseErrorRatePercent() / 100
            );
          }

          // Fault adds to or multiplies the endpoint request count (burst traffic simulation)
          if (EndpointFaultObj.getIncreseRequestCount() > 0) {
            metricsInThisTimeSlot.addEntryPointRequestCount(
              uniqueEndpointName,
              EndpointFaultObj.getIncreseRequestCount()
            )
          } else if (EndpointFaultObj.getRequestMultiplier() > 0) {
            metricsInThisTimeSlot.multiplyEntryPointRequestCount(
              uniqueEndpointName,
              EndpointFaultObj.getRequestMultiplier(),
            )
          }
        }
      }

      // Service-level faults
      const serviceFaultRecordInThisTime = allServiceFaultRecords.get(timeSlotKey);
      if (serviceFaultRecordInThisTime) {
        for (const [uniqueServiceName, ServiceFaultObj] of serviceFaultRecordInThisTime.entries()) {

          // Fault reduces the number of service replicas
          if (ServiceFaultObj.getReducedReplicaCount() > 0) {
            metricsInThisTimeSlot.subtractServiceReplicaCount(
              uniqueServiceName,
              ServiceFaultObj.getReducedReplicaCount()
            )
          }

        }
      }
    }
  }

  private generateAllFaultRecords(
    loadSimulationSettings: TLoadSimulationSettings,
    // basicReplicaCountList: TReplicaCount[]
  ): {
    allEndpointFaultRecords: Map<string, Map<string, EndpointFault>>,
    allServiceFaultRecords: Map<string, Map<string, ServiceFault>>
    /*
      allEndpointFaultRecords:
        -key:"day-hour-minute" 
        -value:
          -key:uniqueEndpointName
          -value:EndpointFault object

      allServiceFaultRecords:
        -key:"day-hour-minute" 
        -value:
          -key:uniqueServiceName
          -value:ServiceFault object
    */
  } {

    const allEndpointFaultRecords = new Map<string, Map<string, EndpointFault>>();
    const allServiceFaultRecords = new Map<string, Map<string, ServiceFault>>();

    if (!loadSimulationSettings.faultInjection) return { allEndpointFaultRecords, allServiceFaultRecords }

    const simulationDurationInDays = loadSimulationSettings.config.simulationDurationInDays;

    //initialize
    for (let day = 0; day < simulationDurationInDays; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const timeSlotKey = `${day}-${hour}-0`;
        allEndpointFaultRecords.set(timeSlotKey, new Map<string, EndpointFault>());
        allServiceFaultRecords.set(timeSlotKey, new Map<string, ServiceFault>());
      }
    }

    loadSimulationSettings.faultInjection.forEach(fault => {
      /*
        建立該 fault 的時間段機率 map（key: timeSlot, value: array of probabilities）
        若同一筆故障設定中，管理員設了多個時間段，但不小心出現時間重疊情況，則機率會重疊
        例如：
          第一個時間段是 day1 startHour 0 duration 3 percent 80 
            => {"0-0-0": 0.8, "0-0-1": 0.8, "0-0-2": 0.8}
          第二個時間段是 day1 startHour 2 duration 2 percent 60 
            => {"0-0-2": 0.6, "0-0-3": 0.6}
        在時間"0-0-2"會同時有兩個機率0.8跟0.6，則"0-0-2"發生機率為1 - 都不發生的機率 = 0.92 (92%)
        合併完的 map就是：
            => {"0-0-0": 0.8, "0-0-1": 0.8, "0-0-2": 0.92, "0-0-3": 0.6}
      */
      const rawProbGroupMap = new Map<string, number[]>();
      fault.timePeriods.forEach(timePeriod => {
        const percent = (timePeriod.probabilityPercent ?? 100) / 100;
        for (let h = 0; h < timePeriod.durationHours; h++) {
          const currentHour = timePeriod.startTime.hour + h;
          const actualDay = timePeriod.startTime.day + Math.floor(currentHour / 24) - 1;
          const actualHour = currentHour % 24;
          const timeSlotKey = `${actualDay}-${actualHour}-0`;
          if (!rawProbGroupMap.has(timeSlotKey)) {
            rawProbGroupMap.set(timeSlotKey, []);
          }
          rawProbGroupMap.get(timeSlotKey)!.push(percent);
        }
      });
      const timeSlotProbMap = new Map<string, number>();
      for (const [timeSlotKey, probs] of rawProbGroupMap.entries()) {
        const noneProb = probs.reduce((acc, p) => acc * (1 - p), 1);//都不發生的機率
        timeSlotProbMap.set(timeSlotKey, 1 - noneProb);
      }

      // 故障注入
      for (const [timeSlotKey, prob] of timeSlotProbMap.entries()) {
        const isFaultOccur = Math.random() <= prob;
        if (!isFaultOccur) continue;

        // fault type checking
        const isLatency = fault.type === 'increase-latency';
        const isErrorRate = fault.type === 'increase-error-rate';
        const isTrafficInjection = fault.type === "inject-traffic"
        const isReduceInstance = fault.type === 'reduce-instance';


        if (isLatency || isErrorRate || isTrafficInjection) {// Endpoint faults
          const epFaultRecordInThisTimeSlot = allEndpointFaultRecords.get(timeSlotKey);
          if (!epFaultRecordInThisTimeSlot) continue;

          const latency = isLatency ? fault.increaseLatencyMs : 0;
          const errorRatePercent = isErrorRate ? fault.increaseErrorRatePercent : 0;
          const reqCount = isTrafficInjection ? fault.increaseRequestCount : 0;
          const reqMultiplier = isTrafficInjection ? fault.requestMultiplier : 0;

          // Add fault records for each target endpoint
          fault.targets.endpoints.forEach(ep => {
            const uniqueEndpointName = ep.uniqueEndpointName!
            let faultObj = epFaultRecordInThisTimeSlot.get(uniqueEndpointName);
            if (!faultObj) {
              faultObj = new EndpointFault();
              epFaultRecordInThisTimeSlot.set(uniqueEndpointName, faultObj);
            }
            faultObj.setIncreaseLatency(latency);
            faultObj.setIncreaseErrorRatePercent(errorRatePercent);
            if (reqCount) {
              faultObj.setIncreseRequestCount(reqCount);
            }
            if (reqMultiplier) {
              faultObj.setRequestMultiplier(reqMultiplier);
            }
          });

        } else if (isReduceInstance) {// Service faults
          const svcFaultRecordInThisTimeSlot = allServiceFaultRecords.get(timeSlotKey);
          if (!svcFaultRecordInThisTimeSlot) continue;

          const reducedReplicaCount = isReduceInstance ? fault.reduceCount : 0;

          // Add fault records for each target service
          fault.targets.services.forEach(svc => {
            const uniqueServiceName = svc.uniqueServiceName!;
            let faultObj = svcFaultRecordInThisTimeSlot.get(uniqueServiceName);
            if (!faultObj) {
              faultObj = new ServiceFault();
              svcFaultRecordInThisTimeSlot.set(uniqueServiceName, faultObj);
            }
            faultObj.setReducedReplicaCount(reducedReplicaCount);
          });
        }
      }
    });

    return {
      allEndpointFaultRecords,
      allServiceFaultRecords
    }
  }
}
//測試用
function printNestedFaultRecords(
  faultRecords: Map<string, Map<string, EndpointFault | ServiceFault>>,
  isEndpointFault: boolean
) {
  const result: Record<string, Record<string, any>> = {};

  for (const [timeSlotKey, innerMap] of faultRecords.entries()) {
    result[timeSlotKey] = {};
    for (const [uniqueName, faultObj] of innerMap.entries()) {
      if (isEndpointFault) {
        const epFault = faultObj as EndpointFault;
        result[timeSlotKey][uniqueName] = {
          increaseLatency: epFault.getIncreaseLatency(),
          increaseErrorRatePercent: epFault.getIncreaseErrorRatePercent(),
          increaseRequestCount: epFault.getIncreseRequestCount(),
          requestMultiplier: epFault.getRequestMultiplier(),
        };
      } else {
        const svcFault = faultObj as ServiceFault;
        result[timeSlotKey][uniqueName] = {
          reducedReplicaCount: svcFault.getReducedReplicaCount()
        };
      }
    }
  }
  if (isEndpointFault) {
    console.log("\nendpoint FaultRecords = ", JSON.stringify(result, null, 2));
  } else {
    console.log("\nservice FaultRecords = ", JSON.stringify(result, null, 2));
  }

}


/**
 * Endpoint Fault Injection
 * 
 * Represents faults that can be targeted to specific endpoints or services.
 * This includes increaseLatency, increaseErrorRate,or injectTraffic.
 */
class EndpointFault {
  private _increaseLatency: number;
  private _increaseErrorRatePercent: number;
  private _increseRequestCount: number;
  private _requestMultiplier: number;
  constructor(
    increaseLatency: number = 0,
    increaseErrorRatePercent: number = 0,
    increseRequestCount: number = 0,
    requestMultiplier: number = 0
  ) {
    this._increaseLatency = Math.max(0, increaseLatency);
    this._increaseErrorRatePercent = Math.min(Math.max(0, increaseErrorRatePercent), 100);
    this._increseRequestCount = Math.max(0, increseRequestCount);
    this._requestMultiplier = Math.max(0, requestMultiplier);
  }

  setIncreaseLatency(next: number) {
    this._increaseLatency = Math.max(0, next);
  }
  setIncreaseErrorRatePercent(next: number) {
    this._increaseErrorRatePercent = Math.min(Math.max(0, next), 100);
  }
  setIncreseRequestCount(next: number) {
    this._increseRequestCount = Math.max(0, next);
  }
  setRequestMultiplier(next: number) {
    this._requestMultiplier = Math.max(0, next);
  }

  getIncreaseLatency() {
    return this._increaseLatency;
  }
  getIncreaseErrorRatePercent() {
    return this._increaseErrorRatePercent;
  }
  getIncreseRequestCount(): number {
    return this._increseRequestCount;
  }
  getRequestMultiplier(): number {
    return this._requestMultiplier;
  }
}

/**
 * Service Fault Injection
 * 
 * Represents faults that target the service level, such as reduceInstance.
 */
class ServiceFault {
  private _reducedReplicaCount: number;

  constructor(
    reducedReplicaCount: number = 0,
  ) {
    this._reducedReplicaCount = Math.max(0, reducedReplicaCount);
  }

  setReducedReplicaCount(next: number) {
    this._reducedReplicaCount = Math.max(0, next);
  }

  getReducedReplicaCount() {
    return this._reducedReplicaCount;
  }

}

