import MLModelClient, { MLModelType, TMLTrainingService } from "./MLModelClient";
import PredictedLoadPropagator, { TPredictedServiceLoad, TServiceTrafficProfile } from "./PredictedLoadPropagator";
import SimulatorUtils from "../SimulatorUtils";
import {
  TSimulationEndpointMetric,
  TSimulationNamespaceServiceMetrics,
} from "../../entities/TSimConfigLoadSimulation";
import {
  TCMetricsPerTimeSlot,
  TDependOnMapWithCallProbability,
} from "../../entities/TLoadSimulation";

const SECONDS_PER_HOUR = 3600;
const PERCENT = 100;

/*
  Models predict each hour's share of the day's traffic (percent), per service, so a
  prediction becomes RPS through that service's configured external daily total:
    RPS = share * D_S / 100 / 3600
*/
export default class MLScalingHandler {
  private static instance?: MLScalingHandler;
  static getInstance = () => this.instance || (this.instance = new this());

  private mlClient: MLModelClient;
  private propagator = new PredictedLoadPropagator();

  private constructor() {
    this.mlClient = MLModelClient.getInstance();
  }

  /*
    Predicted RPS per slot for every service whose autoScaling names a model. Nothing
    here depends on scaling decisions, so the whole table is built before the scaling
    loop runs. Throws if training fails.
  */
  async planPredictedLoads(input: {
    serviceMetrics: TSimulationNamespaceServiceMetrics[];
    endpointMetrics: TSimulationEndpointMetric[];
    dependOnMap: TDependOnMapWithCallProbability;
    metricsPerTimeSlotMap: Map<string, TCMetricsPerTimeSlot>;
    sortedTimeSlotKeys: string[];
  }): Promise<Map<string, Map<string, TPredictedServiceLoad>>> {
    const modelServices = this.modelServices(input.serviceMetrics);
    if (modelServices.size === 0) return new Map();

    const profile = this.buildTrafficProfile(input.endpointMetrics);
    const training = this.trainingServices(profile, modelServices);
    const ownPredictions = new Map<string, (number | null)[] | null>();

    if (training.length > 0) {
      await this.mlClient.train(training);
      for (const { service, model, dailyRequestCount } of training) {
        const shares = this.observedShares(service, profile, input.sortedTimeSlotKeys, input.metricsPerTimeSlotMap);
        const predicted = await this.mlClient.predictShares(service, model, shares);
        ownPredictions.set(service, predicted && predicted.map(
          share => share === null ? null : this.shareToRPS(share, dailyRequestCount)
        ));
      }
    }

    return this.propagator.propagate({
      sortedTimeSlotKeys: input.sortedTimeSlotKeys,
      profile,
      dependOnMap: input.dependOnMap,
      metricsPerTimeSlotMap: input.metricsPerTimeSlotMap,
      ownPredictions,
      modelServices: Array.from(modelServices.keys()),
    });
  }

  buildTrafficProfile(endpointMetrics: TSimulationEndpointMetric[]): TServiceTrafficProfile {
    const profile: TServiceTrafficProfile = {
      endpointDaily: new Map(),
      serviceDaily: new Map(),
      endpointsOfService: new Map(),
    };
    for (const metric of endpointMetrics) {
      if (!metric.uniqueEndpointName) continue;
      const endpoint = metric.uniqueEndpointName;
      const service = SimulatorUtils.extractUniqueServiceNameFromEndpointName(endpoint);
      const daily = metric.expectedExternalDailyRequestCount;
      profile.endpointDaily.set(endpoint, daily);
      profile.serviceDaily.set(service, (profile.serviceDaily.get(service) ?? 0) + daily);
      profile.endpointsOfService.set(service, [...(profile.endpointsOfService.get(service) ?? []), endpoint]);
    }
    return profile;
  }

  modelServices(serviceMetrics: TSimulationNamespaceServiceMetrics[]): Map<string, MLModelType> {
    const models = new Map<string, MLModelType>();
    for (const ns of serviceMetrics) {
      for (const svc of ns.services) {
        for (const ver of svc.versions) {
          if (ver.uniqueServiceName && ver.autoScaling?.model) {
            models.set(ver.uniqueServiceName, ver.autoScaling.model);
          }
        }
      }
    }
    return models;
  }

  // Only services with external traffic get a model of their own; the rest are
  // reached through propagation.
  trainingServices(profile: TServiceTrafficProfile, modelServices: Map<string, MLModelType>): TMLTrainingService[] {
    return Array.from(modelServices.entries())
      .filter(([service]) => (profile.serviceDaily.get(service) ?? 0) > 0)
      .map(([service, model]) => ({ service, model, dailyRequestCount: profile.serviceDaily.get(service)! }))
      .sort((a, b) => a.service.localeCompare(b.service));
  }

  // External arrivals only: the models learnt the share of external daily traffic.
  observedShares(
    service: string,
    profile: TServiceTrafficProfile,
    sortedTimeSlotKeys: string[],
    metricsPerTimeSlotMap: Map<string, TCMetricsPerTimeSlot>
  ): number[] {
    const daily = profile.serviceDaily.get(service) ?? 0;
    const endpoints = profile.endpointsOfService.get(service) ?? [];
    return sortedTimeSlotKeys.map(key => {
      const metrics = metricsPerTimeSlotMap.get(key);
      const count = endpoints.reduce((sum, e) => sum + (metrics?.getEntryPointRequestCount(e) ?? 0), 0);
      return daily > 0 ? count / daily * PERCENT : 0;
    });
  }

  // A negative share is a model artefact, not demand.
  shareToRPS(share: number, dailyRequestCount: number): number {
    return Math.max(0, share) * dailyRequestCount / PERCENT / SECONDS_PER_HOUR;
  }
}
