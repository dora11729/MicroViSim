import { TSimulationNamespace } from "../../entities/TSimConfigServiceInfo";
import { TSimConfigValidationError } from "../../entities/TSimConfigValidationError";

import SimulatorUtils from "../SimulatorUtils";



export default class SimConfigServicesInfoValidator {
  validate(
    servicesInfoConfig: TSimulationNamespace[]
  ): TSimConfigValidationError[] {
    const duplicateServiceErrors = this.checkDuplicateServiceDefinitions(servicesInfoConfig);
    if (duplicateServiceErrors.length) return duplicateServiceErrors;

    const duplicateEndpointIdErrors = this.checkDuplicateEndpointDefinitions(servicesInfoConfig);
    if (duplicateEndpointIdErrors.length) return duplicateEndpointIdErrors;

    // If no errors found, return an empty array.
    return [];
  }

  private checkDuplicateServiceDefinitions(
    servicesInfoConfig: TSimulationNamespace[]
  ): TSimConfigValidationError[] {
    const errorMessages: TSimConfigValidationError[] = [];
    const existingUniqueServiceName = new Set<string>();

    servicesInfoConfig.forEach(ns =>
      ns.services.forEach(svc =>
        svc.versions.forEach(ver => {
          const uniqueServiceName = SimulatorUtils.generateUniqueServiceName(svc.serviceName, ns.namespace, ver.version);

          // Check for duplicates
          if (existingUniqueServiceName.has(uniqueServiceName)) {
            errorMessages.push({
              errorLocation: `servicesInfo > namespace: ${ns.namespace} > serviceName: ${svc.serviceName} > version: ${ver.version}`,
              message: `Duplicate service found.`
            });
          } else {
            existingUniqueServiceName.add(uniqueServiceName);
          }
        })
      )
    );
    return errorMessages;
  }

  private checkDuplicateEndpointDefinitions(
    servicesInfoConfig: TSimulationNamespace[]
  ): TSimConfigValidationError[] {
    const errorMessages: TSimConfigValidationError[] = [];
    const allDefinedEndpointIds = new Set<string>();
    const allDefinedUniqueEndpointNames = new Set<string>();


    servicesInfoConfig.forEach(ns =>
      ns.services.forEach(svc =>
        svc.versions.forEach(ver =>
          ver.endpoints.forEach(ep => {
            // Check if there is a duplicate endpoint ID
            if (allDefinedEndpointIds.has(ep.endpointId)) {
              errorMessages.push({
                errorLocation: `servicesInfo > namespace: ${ns.namespace} > serviceName: ${svc.serviceName} > version: ${ver.version} > endpointId: ${ep.endpointId}`,
                message: `Duplicate endpointId found.`
              });
            } else {
              allDefinedEndpointIds.add(ep.endpointId);
            }
            
            //Check if there are duplicate endpoint paths through uniqueEndpointName
            const uniqueEndpointName = SimulatorUtils.generateUniqueEndpointName(
              svc.serviceName,
              ns.namespace,
              ver.version,
              ep.endpointInfo.method.toUpperCase(),
              ep.endpointInfo.path
            );
            if (allDefinedUniqueEndpointNames.has(uniqueEndpointName)) {
              errorMessages.push({
                errorLocation: `servicesInfo > namespace: ${ns.namespace} > serviceName: ${svc.serviceName} > version: ${ver.version} > endpointId: ${ep.endpointId}`,
                message: `The endpoint with method "${ep.endpointInfo.method.toUpperCase()}" and path "${ep.endpointInfo.path}" has already been defined.`
              });
            } else {
              allDefinedUniqueEndpointNames.add(uniqueEndpointName);
            }
          })
        )
      )
    );


    return errorMessages;
  }
}