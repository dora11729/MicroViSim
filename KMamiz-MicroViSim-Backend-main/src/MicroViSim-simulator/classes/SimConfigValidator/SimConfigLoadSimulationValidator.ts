import { TServiceInfoDefinitionContext } from "../../entities/TServiceInfoDefinitionContext";
import SimulatorUtils from "../SimulatorUtils";
import { TSimulationFaults } from "../../entities/TSimConfigFaultInjection";
import { TLoadSimulationSettings } from "../../entities/TSimConfigLoadSimulation";
import { TSimConfigValidationError } from "../../entities/TSimConfigValidationError";


export default class SimConfigLoadSimulationValidator {

  validate(
    loadSimulationSettings: TLoadSimulationSettings,
    serviceInfoDefinitionContext: TServiceInfoDefinitionContext,
  ): TSimConfigValidationError[] {

    // validate metrics
    const serviceMetricErrors = this.validateServiceMetrics(
      loadSimulationSettings,
      serviceInfoDefinitionContext
    );
    const endpointMetricErrors = this.validateEndpointMetrics(
      loadSimulationSettings, serviceInfoDefinitionContext);
    const metricErrors = [
      ...serviceMetricErrors,
      ...endpointMetricErrors,
    ];
    if (metricErrors.length) return metricErrors;

    // validate faults
    if (loadSimulationSettings.faultInjection) {
      const faultsTargetsErrors = this.validateFaultsTargets(
        loadSimulationSettings.faultInjection, serviceInfoDefinitionContext
      )
      if (faultsTargetsErrors.length) return faultsTargetsErrors;
    }

    // If no errors found, return an empty array.
    return [];
  }

  // check each service in serviceMetrics is defined in servicesInfo
  // and Assign uniqueServiceName to each serviceMetric
  private validateServiceMetrics(
    loadSimulationSettings: TLoadSimulationSettings,
    serviceInfoDefinitionContext: TServiceInfoDefinitionContext,
  ): TSimConfigValidationError[] {
    const errorMessages: TSimConfigValidationError[] = [];

    loadSimulationSettings.serviceMetrics.forEach((namespace, nsIndex) => {
      namespace.services.forEach((service, svcIndex) => {
        const serviceLocation = `loadSimulation.serviceMetrics[${nsIndex}].services[${svcIndex}]`;
        service.versions.forEach((version, verIndex) => {
          const versionLocation = `${serviceLocation}.versions[${verIndex}]`;
          const uniqueServiceName = SimulatorUtils.generateUniqueServiceName(
            service.serviceName,
            namespace.namespace,
            version.version
          )
          if (!serviceInfoDefinitionContext.allDefinedUniqueServiceNames.has(uniqueServiceName)) {
            errorMessages.push({
              errorLocation: versionLocation,
              message: `service "${service.serviceName}" in namespace "${namespace.namespace}" with version "${version.version}" is not defined in servicesInfo.`,
            });
          } else {
            //assign uniqueServiceName
            version.uniqueServiceName = uniqueServiceName;
          }
        })
      })
    });

    const seenServiceVersions = new Set<string>();
    loadSimulationSettings.serviceMetrics.forEach((namespace, nsIndex) => {
      namespace.services.forEach((service, svcIndex) => {
        const serviceLocation = `loadSimulation.serviceMetrics[${nsIndex}].services[${svcIndex}]`;

        service.versions.forEach((version, verIndex) => {
          const versionLocation = `${serviceLocation}.versions[${verIndex}]`;
          const uniqueServiceName = SimulatorUtils.generateUniqueServiceName(
            service.serviceName,
            namespace.namespace,
            version.version
          )
          if (seenServiceVersions.has(uniqueServiceName)) {
            errorMessages.push({
              errorLocation: versionLocation,
              message: `Duplicate service "${service.serviceName}" in namespace "${namespace.namespace}" with version "${version.version}" found in serviceMetrics.`,
            });
          } else {
            seenServiceVersions.add(uniqueServiceName);
          }
        });
      });
    });

    return errorMessages;
  }

  // check each endpointId in endpointMetrics is defined in servicesInfo
  private validateEndpointMetrics(
    loadSimulationSettings: TLoadSimulationSettings,
    serviceInfoDefinitionContext: TServiceInfoDefinitionContext,
  ): TSimConfigValidationError[] {
    const errorMessages: TSimConfigValidationError[] = [];
    const seenEndpointIds = new Set<string>();
    loadSimulationSettings.endpointMetrics.forEach((m, index) => {
      const errorLocation = `loadSimulation.endpointMetrics[${index}]`;
      if (!serviceInfoDefinitionContext.allDefinedEndpointIds.has(m.endpointId)) {
        errorMessages.push({
          errorLocation: errorLocation,
          message: `EndpointId "${m.endpointId}" is not defined in servicesInfo.`,
        });
      }
    });
    loadSimulationSettings.endpointMetrics.forEach((m, index) => {
      const errorLocation = `loadSimulation.endpointMetrics[${index}]`;
      if (seenEndpointIds.has(m.endpointId)) {
        errorMessages.push({
          errorLocation: errorLocation,
          message: `Duplicate endpointId "${m.uniqueEndpointName}" found in endpointMetrics.`,
        });
      } else {
        seenEndpointIds.add(m.endpointId);
      }
    });

    return errorMessages;
  }

  private validateFaultsTargets(
    faultSettings: TSimulationFaults[],
    serviceInfoDefinitionContext: TServiceInfoDefinitionContext,
  ): TSimConfigValidationError[] {
    const undefinedTargetServicesErrors = this.checkUndefinedTargetServicesInFaults(
      faultSettings,
      serviceInfoDefinitionContext
    );

    const undefinedTargetEndpointsErrors = this.checkUndefinedTargetEndpointsInFaults(
      faultSettings,
      serviceInfoDefinitionContext
    )

    return [
      ...undefinedTargetServicesErrors,
      ...undefinedTargetEndpointsErrors,
    ];
  }

  // Validate that the target services in each fault are defined in the servicesInfo configuration
  private checkUndefinedTargetServicesInFaults(
    faultSettings: TSimulationFaults[],
    serviceInfoDefinitionContext: TServiceInfoDefinitionContext,
  ): TSimConfigValidationError[] {
    const errorMessages: TSimConfigValidationError[] = [];

    // Extract unique service names without version from all assigned unique service names
    const allDefinedServiceNamesWithNs = new Set(Array.from(serviceInfoDefinitionContext.allDefinedUniqueServiceNames).map(str => {
      const [serviceName, namespace] = str.split('\t');
      return SimulatorUtils.generateUniqueServiceNameWithoutVersion(serviceName, namespace);

    }));

    // start validation
    faultSettings.forEach((fault, faultIndex) => {
      fault.targets.services.forEach((targetService, targetServiceIndex) => {
        const errorTargetServiceLocation = `loadSimulation.faults[${faultIndex}].services[${targetServiceIndex}]`;
        const uniqueServiceNameWithoutVersion =
          SimulatorUtils.generateUniqueServiceNameWithoutVersion(
            targetService.serviceName,
            targetService.namespace
          );
        if (allDefinedServiceNamesWithNs.has(uniqueServiceNameWithoutVersion)) {
          // If version is specified, check if the exact service version exists in assigned services
          if (targetService.version) {
            const uniqueServiceName = SimulatorUtils.generateUniqueServiceName(
              targetService.serviceName,
              targetService.namespace,
              targetService.version
            )
            if (!serviceInfoDefinitionContext.allDefinedUniqueServiceNames.has(uniqueServiceName)) {
              errorMessages.push({
                errorLocation: errorTargetServiceLocation,
                message: `Service "${targetService.serviceName}" in namespace "${targetService.namespace}" with version "${targetService.version}" is not defined in servicesInfo.`,
              });
            }
          }
        } else {
          // Service name and namespace combination does not exist in servicesInfo
          errorMessages.push({
            errorLocation: errorTargetServiceLocation,
            message: `Service "${targetService.serviceName}" in namespace "${targetService.namespace}" is not defined in servicesInfo.`,
          });
        }
      })
    });

    return errorMessages;
  }

  // For faults that can specify target endpoints, validate that the target endpointIds are defined in servicesInfo
  private checkUndefinedTargetEndpointsInFaults(
    faultSettings: TSimulationFaults[],
    serviceInfoDefinitionContext: TServiceInfoDefinitionContext,
  ): TSimConfigValidationError[] {
    const errorMessages: TSimConfigValidationError[] = [];

    faultSettings.forEach((fault, faultIndex) => {
      if (fault.type == 'increase-error-rate' || fault.type == 'increase-latency' || fault.type == "inject-traffic") {
        fault.targets.endpoints.forEach((targetEndpoint, targetEndpointIndex) => {
          if (!serviceInfoDefinitionContext.allDefinedEndpointIds.has(targetEndpoint.endpointId)) {
            const errorTargetEndpointLocation = `loadSimulation.faults[${faultIndex}].endpoints[${targetEndpointIndex}]`;
            errorMessages.push({
              errorLocation: errorTargetEndpointLocation,
              message: `EndpointId "${targetEndpoint.endpointId}" is not defined in servicesInfo.`,
            });
          }
        })
      }
    })
    faultSettings.forEach((fault, faultIndex) => {
      if (fault.type == "inject-traffic") {
        const hasCount = fault.increaseRequestCount !== undefined;
        const hasRate = fault.requestMultiplier !== undefined;
        if ((hasCount && hasRate) || (!hasCount && !hasRate)) {
          const errorLocation = `loadSimulation.faults[${faultIndex}]`;
          errorMessages.push({
            errorLocation: errorLocation,
            message: `Exactly one of the fields increaseRequestCount or requestMultiplier must be set.`,
          });
        }
      }
    })

    return errorMessages;
  }
}