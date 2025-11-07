
import {
  TSimulationEndpointDependency,
  isSelectOneOfGroupDependOnType
} from "../../entities/TSimConfigEndpointDependency";
import { TServiceInfoDefinitionContext } from "../../entities/TServiceInfoDefinitionContext";
import { TSimConfigValidationError } from "../../entities/TSimConfigValidationError";

export default class SimConfigEndpointDependenciesPreprocessor {
  preprocess(
    endpointDependenciesConfig: TSimulationEndpointDependency[],
    serviceInfoDefinitionContext: TServiceInfoDefinitionContext,
  ): TSimConfigValidationError[] {
    const assignUniqueEndpointNameErrors = this.assignUniqueEndpointName(
      endpointDependenciesConfig,
      serviceInfoDefinitionContext
    );
    if (assignUniqueEndpointNameErrors.length) return assignUniqueEndpointNameErrors;

    // If no errors found, return an empty array.
    return [];
  }

  // Assign uniqueEndpointName to each endpoint for later use
  private assignUniqueEndpointName(
    endpointDependenciesConfig: TSimulationEndpointDependency[],
    serviceInfoDefinitionContext: TServiceInfoDefinitionContext,
  ): TSimConfigValidationError[] {
    // errorMessages is here only as a safeguard.
    // If the previous validations were correctly implemented, this error should not occur
    const errorMessages: TSimConfigValidationError[] = [];

    endpointDependenciesConfig.forEach((source, sourceIndex) => {
      source.uniqueEndpointName =
        serviceInfoDefinitionContext.endpointIdToUniqueNameMap.get(source.endpointId);
      if (!source.uniqueEndpointName) {
        const sourceLocation = `endpointDependencies[${sourceIndex}].endpointId`;
        errorMessages.push({
          errorLocation: sourceLocation,
          message: `Failed to assign uniqueEndpointName: endpointId "${source.endpointId}" does not exist in the mapping. (This is unexpected system error!!)`
        });
      }
      source.dependOn.forEach((target, targetIndex) => {
        const targetLocation = `endpointDependencies[${sourceIndex}].dependOn[${targetIndex}]`;
        if (isSelectOneOfGroupDependOnType(target)) {
          target.oneOf.forEach((one, oneIndex) => {
            one.uniqueEndpointName =
              serviceInfoDefinitionContext.endpointIdToUniqueNameMap.get(one.endpointId);
            if (!one.uniqueEndpointName) {
              const oneLocation = `${targetLocation}.oneOf[${oneIndex}]`;
              errorMessages.push({
                errorLocation: oneLocation,
                message: `Failed to assign uniqueEndpointName: endpointId "${one.endpointId}" does not exist in the mapping. (This is unexpected system error!!)`
              });
            }
          })
        } else {
          target.uniqueEndpointName =
            serviceInfoDefinitionContext.endpointIdToUniqueNameMap.get(target.endpointId);
          if (!target.uniqueEndpointName) {

            errorMessages.push({
              errorLocation: targetLocation,
              message: `Failed to assign uniqueEndpointName: endpointId "${target.endpointId}" does not exist in the mapping. (This is unexpected system error!!)`
            });
          }
        }
      });
    });
    return errorMessages;
  }


}