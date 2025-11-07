import { TRealtimeData } from "../../entities/TRealtimeData";
import { TSimulationEndpointDatatype } from "./TSimConfigServiceInfo";
import { TSimulationEndpointDelay } from "./TSimConfigLoadSimulation";


/*
  Used to generate data in a format compatible with KMamiz after simulation, 
  enabling the creation of dynamic simulation metrics
*/
type TBaseRealtimeData = Omit<
  TRealtimeData,
  'latency' | 'status' | 'responseBody' | 'responseContentType' | 'timestamp' | 'replica'
>;
export type TBaseDataWithResponses = {
  baseData: TBaseRealtimeData,
  responses?: TSimulationEndpointDatatype['responses'],
}



/*
  Used to summarize the statistics of traffic propagation for a single time slot
*/
export type TEndpointPropagationStatsForOneTimeSlot = {
  requestCount: number;
  ownErrorCount: number;        // Number of errors originating from the endpointNode itself
  downstreamErrorCount: number; // Number of errors caused by downstream endpointNodes
  latencyStatsByStatus: Map<string, { mean: number; cv: number }>; //Key: status code, Value: latency statistics (mean and coefficient of variation) for all requests with this status code

};



/*
  The DependOn Map with CallProbability is used for load simulation propagation
*/
export type TTargetWithCallProbability = {
  targetEndpointUniqueEndpointName: string;
  callProbability: number;
};



/*
  TDependOnCallProbabilityArray is a two-dimensional array.
  Each element of the outer array represents a group of dependent endpoints.
  The inner array contains the dependent endpoints within that group along with their corresponding call probabilities.
  Calls within the same group are mutually exclusive, meaning only one endpoint is randomly selected to be called.
  If the total call probability in the group is less than 100%, there is a chance that none of the endpoints will be called.
*/
export type TDependOnMapWithCallProbability = Map<string, TTargetWithCallProbability[][]>;



/* 
  TCMetricsPerTimeSlot records the dynamic characteristics of each service and endpoint during a specific time slot,
  such as the number of active replicas, endpoint error rates, request counts, and latency metrics.
*/
export class TCMetricsPerTimeSlot {

  // Aggregates the number of external requests received during the current time slot
  // key: The uniqueEndpointName of the endpoint that receives external requests (i.e., the entry point)
  // value: The number of requests received
  private _entryPointRequestCountMap: Map<string, number>;

  // Aggregates endpoint latency data during the current time slot
  // key: uniqueEndpointName
  // value: An object containing latencyMs and jitterMs
  private _endpointDelayMap: Map<string, TSimulationEndpointDelay>;

  // Aggregates the error rates of endpoints during the current time slot
  // key: uniqueEndpointName
  // value: error rate (0~1)
  private _endpointErrorRate: Map<string, number>;

  // Aggregates the number of service replicas during the current time slot
  // key: uniqueServiceName
  // value: The number of active replicas
  private _serviceReplicaCountMap: Map<string, number>;

  // Records the capacity (RPS) of a single replica for each service
  // key: uniqueServiceName
  // value: The throughput capacity (RPS) of one replica
  private _serviceCapacityPerReplicaMap: Map<string, number>;

  constructor() {
    this._entryPointRequestCountMap = new Map<string, number>();
    this._serviceReplicaCountMap = new Map<string, number>();
    this._endpointDelayMap = new Map<string, TSimulationEndpointDelay>();
    this._endpointErrorRate = new Map<string, number>();
    this._serviceCapacityPerReplicaMap = new Map<string, number>();
  }

  // Methods to set individual key-value entries into each internal Map
  setEntryPointRequestCount(uniqueEndpointName: string, count: number): void {
    this._entryPointRequestCountMap.set(uniqueEndpointName, Math.max(0, count));
  }
  setEndpointDelay(uniqueEndpointName: string, delay: TSimulationEndpointDelay): void {
    this._endpointDelayMap.set(uniqueEndpointName, {
      latencyMs: Math.max(0, delay.latencyMs),
      jitterMs: Math.max(0, delay.jitterMs),
    });
  }
  setEndpointErrorRate(uniqueEndpointName: string, errorRate: number): void {
    this._endpointErrorRate.set(uniqueEndpointName, Math.max(0, errorRate));
  }
  setServiceCapacityPerReplica(serviceName: string, capacity: number): void {
    this._serviceCapacityPerReplicaMap.set(serviceName, Math.max(0, capacity));
  }
  setServiceReplicaCount(uniqueServiceName: string, count: number): void {
    this._serviceReplicaCountMap.set(uniqueServiceName, Math.max(0, count));
  }

  // Methods to replace internal Maps entirely with new Map instances (deep copies)
  setEntryPointRequestCountMap(newMap: Map<string, number>): void {
    this._entryPointRequestCountMap = new Map(newMap);
  }
  setEndpointDelayMap(newMap: Map<string, TSimulationEndpointDelay>): void {
    this._endpointDelayMap = new Map(newMap);
  }
  setEndpointErrorRateMap(newMap: Map<string, number>): void {
    this._endpointErrorRate = new Map(newMap);
  }
  setServiceReplicaCountMap(newMap: Map<string, number>): void {
    this._serviceReplicaCountMap = new Map(newMap);
  }
  setServiceCapacityPerReplicaMap(newMap: Map<string, number>): void {
    this._serviceCapacityPerReplicaMap = new Map(newMap);
  }

  // Methods to retrieve individual values from internal Maps with sensible defaults
  getEntryPointRequestCount(uniqueEndpointName: string): number {
    return this._entryPointRequestCountMap.get(uniqueEndpointName) ?? 0;
  }
  getEndpointDelay(uniqueEndpointName: string): TSimulationEndpointDelay {
    const defaultDelay: TSimulationEndpointDelay = { latencyMs: 0, jitterMs: 0 };
    return this._endpointDelayMap.get(uniqueEndpointName) ?? defaultDelay;
  }
  getEndpointErrorRate(uniqueEndpointName: string): number {
    return this._endpointErrorRate.get(uniqueEndpointName) ?? 0;
  }
  getServiceReplicaCount(uniqueServiceName: string): number {
    return this._serviceReplicaCountMap.get(uniqueServiceName) ?? 1;
  }
  getServiceCapacityPerReplica(uniqueServiceName: string): number {
    return this._serviceCapacityPerReplicaMap.get(uniqueServiceName) ?? 1;
  }

  // Methods to set individual key-value entries into each internal Map
  getEntryPointRequestCountMap(): Map<string, number> {
    return new Map(this._entryPointRequestCountMap);
  }

  getEndpointDelayMap(): Map<string, TSimulationEndpointDelay> {
    return new Map(this._endpointDelayMap);
  }
  getEndpointErrorRateMap(): Map<string, number> {
    return new Map(this._endpointErrorRate);
  }
  getServiceReplicaCountMap(): Map<string, number> {
    return new Map(this._serviceReplicaCountMap);
  }
  getServiceCapacityPerReplicaMap(): Map<string, number> {
    return new Map(this._serviceCapacityPerReplicaMap);
  }


  // Methods to adjust values in each internal Map.
  addEntryPointRequestCount(uniqueEndpointName: string, delta: number): void {
    const current = this.getEntryPointRequestCount(uniqueEndpointName);
    this.setEntryPointRequestCount(uniqueEndpointName, current + delta);
  }
  multiplyEntryPointRequestCount(uniqueEndpointName: string, factor: number): void {
    const current = this.getEntryPointRequestCount(uniqueEndpointName);
    this.setEntryPointRequestCount(uniqueEndpointName, current * factor);
  }

  addEndpointDelay(uniqueEndpointName: string, delta: TSimulationEndpointDelay): void {
    const current = this.getEndpointDelay(uniqueEndpointName);
    this.setEndpointDelay(uniqueEndpointName, {
      latencyMs: current.latencyMs + delta.latencyMs,
      jitterMs: current.jitterMs + delta.jitterMs,
    });
  }

  addEndpointErrorRate(uniqueEndpointName: string, delta: number): void {
    const current = this.getEndpointErrorRate(uniqueEndpointName);
    this.setEndpointErrorRate(uniqueEndpointName, current + delta);
  }

  addServiceReplicaCount(uniqueServiceName: string, delta: number): void {
    const current = this.getServiceReplicaCount(uniqueServiceName);
    this.setServiceReplicaCount(uniqueServiceName, current + delta);
  }
  subtractServiceReplicaCount(uniqueServiceName: string, delta: number): void {
    const current = this.getServiceReplicaCount(uniqueServiceName);
    this.setServiceReplicaCount(uniqueServiceName, current - delta);
  }

  addServiceCapacityPerReplica(uniqueServiceName: string, delta: number): void {
    const current = this.getServiceCapacityPerReplica(uniqueServiceName);
    this.setServiceCapacityPerReplica(uniqueServiceName, current + delta);
  }


}