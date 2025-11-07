import { TSimulationFaults } from "../../entities/TSimConfigFaultInjection";
import {
  TFallbackStrategy,
  TLoadSimulationSettings,
  TSimulationEndpointMetric,
} from "../../entities/TSimConfigLoadSimulation";
import { TServiceInfoDefinitionContext } from "../../entities/TServiceInfoDefinitionContext";
import { TSimConfigValidationError } from "../../entities/TSimConfigValidationError";
import SimulatorUtils from "../SimulatorUtils";

export default class SimConfigLoadSimulationPreprocessor {

  preprocess(
    loadSimulationSettings: TLoadSimulationSettings,
    serviceInfoDefinitionContext: TServiceInfoDefinitionContext
  ): TSimConfigValidationError[] {

    // preprocess endpointMetric
    const preprocessEndpointMetricsErrors = this.preprocessEndpointMetrics(
      loadSimulationSettings,
      serviceInfoDefinitionContext,
    )
    if (preprocessEndpointMetricsErrors.length) return preprocessEndpointMetricsErrors;

    this.addDefaultMetricsForMissingEndpointsInPlace(loadSimulationSettings, serviceInfoDefinitionContext);

    // preprocess faults
    if (loadSimulationSettings.faultInjection) {
      this.preprocessFaultTargets(loadSimulationSettings.faultInjection, serviceInfoDefinitionContext);
    }

    // If no errors found, return an empty array.
    return [];
  }


  // Assign uniqueEndpointName to each endpointMetric
  private preprocessEndpointMetrics(
    loadSimulationSettings: TLoadSimulationSettings,
    serviceInfoDefinitionContext: TServiceInfoDefinitionContext,
  ): TSimConfigValidationError[] {
    // errorMessages is here only as a safeguard.
    // If the previous validations were correctly implemented, this error should not occur
    const errorMessages: TSimConfigValidationError[] = [];
    loadSimulationSettings.endpointMetrics.forEach((epMetric, index) => {
      epMetric.uniqueEndpointName = serviceInfoDefinitionContext.endpointIdToUniqueNameMap.get(epMetric.endpointId);
      if (!epMetric.uniqueEndpointName) {
        const errorLocation = `loadSimulation.endpointMetrics[${index}].endpointId`;
        errorMessages.push({
          errorLocation: errorLocation,
          message: `Failed to assign uniqueEndpointName: endpointId "${epMetric.uniqueEndpointName}" does not exist in the mapping. (This is unexpected system error!!)`
        });
      }
    });
    return errorMessages;
  }

  private preprocessFaultTargets(
    faultSettings: TSimulationFaults[],
    serviceInfoDefinitionContext: TServiceInfoDefinitionContext,
  ) {
    this.expandFaultTargetServicesWithNoVersionSpecified(
      faultSettings,
      serviceInfoDefinitionContext
    )
    this.convertFaultTargetServicesToEndpoints(
      faultSettings,
      serviceInfoDefinitionContext
    );
  }


  // Expand fault target services that have no version specified into all available versions,
  // and assign uniqueServiceName to each expanded service target.
  private expandFaultTargetServicesWithNoVersionSpecified(
    faultSettings: TSimulationFaults[],
    serviceInfoDefinitionContext: TServiceInfoDefinitionContext,
  ) {
    faultSettings.forEach((fault) => {
      const allUniqueServiceNameSet = new Set<string>();
      fault.targets.services.forEach((targetService) => {
        if (targetService.version) {
          //version is specified
          const uniqueServiceName = SimulatorUtils.generateUniqueServiceName(
            targetService.serviceName,
            targetService.namespace,
            targetService.version
          )
          allUniqueServiceNameSet.add(uniqueServiceName);
        } else {
          // If version is not specified, get all versions of the service
          const uniqueServiceNameWithoutVersion = SimulatorUtils.generateUniqueServiceNameWithoutVersion(
            targetService.serviceName,
            targetService.namespace
          );
          Array.from(serviceInfoDefinitionContext.allDefinedUniqueServiceNames)
            .filter(name => name.startsWith(uniqueServiceNameWithoutVersion))
            .forEach(name => allUniqueServiceNameSet.add(name));
        }
      })

      // Replace the original services with expanded list including versions and uniqueServiceName
      fault.targets.services = Array.from(allUniqueServiceNameSet).map((uniqueServiceName) => {
        const [serviceName, namespace, serviceVersion] = SimulatorUtils.splitUniqueServiceName(uniqueServiceName);
        return {
          namespace: namespace,
          serviceName: serviceName,
          version: serviceVersion,
          uniqueServiceName: uniqueServiceName // Also assign uniqueServiceName here
        }
      })
    })
  }

  // Convert fault target services to all endpoints under those services
  // (Only processes faults that can specify target endpoints)
  private convertFaultTargetServicesToEndpoints(
    faultSettings: TSimulationFaults[],
    serviceInfoDefinitionContext: TServiceInfoDefinitionContext,
  ): void {
    faultSettings.forEach((fault) => {
      // Convert the services specified in the fault's targets into a set of all corresponding endpointIds
      if (fault.type == 'increase-error-rate' || fault.type == 'increase-latency' || fault.type == "inject-traffic") {// faults that can specify target endpoints
        // Collect all endpointIds related to the services specified in this fault's targets
        const allEndpointIdSetForThisFault = new Set<string>();
        fault.targets.services.forEach((targetService) => {
          // Use uniqueServiceName to find corresponding endpointIds
          serviceInfoDefinitionContext.uniqueServiceNameToEndpointIdMap.get(targetService.uniqueServiceName!)?.forEach(endpointId =>
            allEndpointIdSetForThisFault.add(endpointId)
          );
        })

        // Add endpointIds explicitly specified in targets.endpoints 
        // (meaning if the admin specifies a service, no need to specify its endpoints separately)
        fault.targets.endpoints.forEach((targetEndpoint) => {
          allEndpointIdSetForThisFault.add(targetEndpoint.endpointId);
        })

        // Clear targets.services and unify the targets to all corresponding endpoints
        fault.targets.services = []

        // Replace targets.endpoints with all the collected endpoint objects
        fault.targets.endpoints = Array.from(allEndpointIdSetForThisFault).map((endpointId) => {
          return {
            endpointId: endpointId,
            uniqueEndpointName: serviceInfoDefinitionContext.endpointIdToUniqueNameMap.get(endpointId)!
          }
        })
      }
    });
  }


  // Avoid missing base error rates for endpoints when adjusting error rates during load simulation
  private addDefaultMetricsForMissingEndpointsInPlace(
    loadSimulationSettings: TLoadSimulationSettings,
    serviceInfoDefinitionContext: TServiceInfoDefinitionContext,
  ) {
    const allDefinedEndpointIds = new Set(serviceInfoDefinitionContext.endpointIdToUniqueNameMap.keys());
    const endpointMetrics: TSimulationEndpointMetric[] = loadSimulationSettings.endpointMetrics;
    const existingMetricEndpointIds = new Set(endpointMetrics.map(m => m.endpointId));
    const missingEndpointIds = Array.from(allDefinedEndpointIds).filter(id => !existingMetricEndpointIds.has(id));
    const defaultMetrics: TSimulationEndpointMetric[] = missingEndpointIds.map(id => ({
      endpointId: id,
      delay: { latencyMs: 0, jitterMs: 0 },
      expectedExternalDailyRequestCount: 0,
      errorRatePercent: 0,
      fallbackStrategy: "failIfAnyDependentFail" as TFallbackStrategy,
      uniqueEndpointName: serviceInfoDefinitionContext.endpointIdToUniqueNameMap.get(id)!,
    }));
    loadSimulationSettings.endpointMetrics = [...endpointMetrics, ...defaultMetrics];

  }



}
