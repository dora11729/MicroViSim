
import {
  TSimulationEndpointDependency,
  isSelectOneOfGroupDependOnType
} from "../../entities/TSimConfigEndpointDependency";
import { TServiceInfoDefinitionContext } from "../../entities/TServiceInfoDefinitionContext";

import SimEndpointDependencyBuilder from "../SimEndpointDependencyBuilder";
import { TSimConfigValidationError } from "../../entities/TSimConfigValidationError";



export default class SimConfigEndpointDependenciesValidator {
  validate(
    endpointDependenciesConfig: TSimulationEndpointDependency[],
    serviceInfoDefinitionContext: TServiceInfoDefinitionContext
  ): TSimConfigValidationError[] {
    const undefinedEndpointIdsErrors = this.checkUndefinedEndpointIds(endpointDependenciesConfig, serviceInfoDefinitionContext);
    if (undefinedEndpointIdsErrors.length) return undefinedEndpointIdsErrors;

    const duplicatedEndpointIdErrors = this.checkDuplicatedEndpointIdDefinitions(endpointDependenciesConfig);
    if (duplicatedEndpointIdErrors.length) return duplicatedEndpointIdErrors;

    const cyclicDependenciesErrors = this.checkCyclicEndpointDependencies(endpointDependenciesConfig);
    if (cyclicDependenciesErrors.length) return cyclicDependenciesErrors;

    const oneOfCallProbabilitySumErrors = this.checkOneOfCallProbabilitySum(endpointDependenciesConfig);
    if (oneOfCallProbabilitySumErrors.length) return oneOfCallProbabilitySumErrors;

    // If no errors found, return an empty array.
    return [];
  }

  //Check that both source endpointIds and all target endpointIds in dependOn are defined in servicesInfo.
  private checkUndefinedEndpointIds(
    endpointDependenciesConfig: TSimulationEndpointDependency[],
    serviceInfoDefinitionContext: TServiceInfoDefinitionContext,
  ): TSimConfigValidationError[] {
    const errorMessages: TSimConfigValidationError[] = [];
    endpointDependenciesConfig.forEach((dep, index) => {
      const sourceLocation = `endpointDependencies[${index}]`;
      if (!serviceInfoDefinitionContext.allDefinedEndpointIds.has(dep.endpointId)) {
        errorMessages.push({
          errorLocation: sourceLocation,
          message: `Source endpointId "${dep.endpointId}" is not defined in servicesInfo.`,
        });
      }
      dep.dependOn.forEach((target, targetIndex) => {
        const dependOnLocation = `${sourceLocation}.dependOn[${targetIndex}]`;
        if (isSelectOneOfGroupDependOnType(target)) {
          target.oneOf.forEach((one, oneIndex) => {
            if (!serviceInfoDefinitionContext.allDefinedEndpointIds.has(one.endpointId)) {
              const oneOfLocation = `${dependOnLocation}.oneOf[${oneIndex}]`;
              errorMessages.push({
                errorLocation: oneOfLocation,
                message: `Target endpointId "${one.endpointId}" is not defined in servicesInfo.`,
              });
            }
          })

        } else {
          if (!serviceInfoDefinitionContext.allDefinedEndpointIds.has(target.endpointId)) {
            errorMessages.push({
              errorLocation: dependOnLocation,
              message: `Target endpointId "${target.endpointId}" is not defined in servicesInfo.`,
            });
          }
        }

      });
    });

    return errorMessages;
  }
  // Check for duplicate endpointIds within endpointDependencies
  private checkDuplicatedEndpointIdDefinitions(
    endpointDependenciesConfig: TSimulationEndpointDependency[],
  ): TSimConfigValidationError[] {
    const errorMessages: TSimConfigValidationError[] = [];
    const seenSourceEndpointIds = new Set<string>();

    // outer loop: Check for duplicate source endpointIds within endpointDependencies
    endpointDependenciesConfig.forEach((source, sourceIndex) => {
      const sourceEPLocation = `endpointDependencies[${sourceIndex}]`;

      if (seenSourceEndpointIds.has(source.endpointId)) {
        errorMessages.push({
          errorLocation: sourceEPLocation,
          message: `Duplicate source endpointId "${source.endpointId}" found.`,
        });
      } else {
        seenSourceEndpointIds.add(source.endpointId);

        // inner loop: Check for duplicate target endpointIds within endpointDependencies
        const seenTargetEndpointIds = new Set<string>();
        source.dependOn.forEach((target) => {
          const targetEPLocation = `${sourceEPLocation}.dependOn`;
          if (isSelectOneOfGroupDependOnType(target)) {
            target.oneOf.forEach((one) => {
              if (seenTargetEndpointIds.has(one.endpointId)) {
                errorMessages.push({
                  errorLocation: targetEPLocation,
                  message: `Duplicate endpointId "${one.endpointId}" found in the dependOn list for "${source.endpointId}".`,
                });
              } else {
                seenTargetEndpointIds.add(one.endpointId);
              }
            })
          } else {
            if (seenTargetEndpointIds.has(target.endpointId)) {
              errorMessages.push({
                errorLocation: targetEPLocation,
                message: `Duplicate endpointId "${target.endpointId}" found in the dependOn list for "${source.endpointId}".`,
              });
            } else {
              seenTargetEndpointIds.add(target.endpointId);
            }
          }
        })
      }
    });



    // The reason why checking target endpointIds is unnecessary is because this issue 
    // can be avoided later during the construction of the dependOnMap(targets stored in Set).

    return errorMessages;
  }

  private checkOneOfCallProbabilitySum(
    endpointDependenciesConfig: TSimulationEndpointDependency[]
  ): TSimConfigValidationError[] {
    const errorMessages: TSimConfigValidationError[] = [];

    endpointDependenciesConfig.forEach((source, sourceIndex) => {
      const sourceEPLocation = `endpointDependencies[${sourceIndex}]`;

      source.dependOn.forEach((target, targetIndex) => {
        if (isSelectOneOfGroupDependOnType(target)) {
          const targetEPLocation = `${sourceEPLocation}.dependOn[${targetIndex}]`;
          const totalProbability = target.oneOf.reduce((sum, one) => {
            return sum + one.callProbability;
          }, 0);

          if (totalProbability > 100) {
            errorMessages.push({
              errorLocation: targetEPLocation,
              message: `Total callProbability of oneOf group exceeds 100 for source endpoint "${source.endpointId}". The current total is ${totalProbability}.`,
            });
          }
        }
      });
    });

    return errorMessages;
  }

  // Check for cyclic dependency issues (including self-dependencies)
  private checkCyclicEndpointDependencies(
    endpointDependencies: TSimulationEndpointDependency[],
  ): TSimConfigValidationError[] {
    // Store all detected error messages
    const errorMessages: TSimConfigValidationError[] = [];

    // Create a dependency graph using Map,
    // where each endpoint maps to the list of endpoint IDs it depends on

    const { dependOnMap } = SimEndpointDependencyBuilder.getInstance().buildDependOnMapForValidator(endpointDependencies);
    // Track already reported cycles to avoid duplicate error messages
    const reportedCycles = new Set<string>();

    /**
     * Depth-First Search (DFS) for detecting Cyclic dependencies
     * @param node The current node being visited
     * @param currentPath The current DFS traversal path
     * @param visited A set of nodes visited in the current DFS path
     */
    function dfsForDetectCycle(node: string, currentPath: string[], visited: Set<string>) {
      currentPath.push(node); // Add the current node to the DFS path
      visited.add(node);      // Mark the node as visited (within this DFS path)

      // Get the list of neighboring nodes (dependencies)
      const neighbors = dependOnMap.get(node) || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          // If the neighbor hasn't been visited in this path, continue DFS
          dfsForDetectCycle(neighbor, currentPath, visited);
        } else {
          // If the neighbor is already in the current path, a cycle is detected
          const cycleStartIndex = currentPath.indexOf(neighbor);
          if (cycleStartIndex !== -1) {
            // Extract the cycle path from the path and complete the loop
            const cyclePath = currentPath.slice(cycleStartIndex).concat(neighbor);

            // Normalize the cycle path using sorted unique nodes to prevent duplicate reports
            const normalizedCycle = [...new Set(cyclePath)].sort().join("->");
            if (!reportedCycles.has(normalizedCycle)) {
              reportedCycles.add(normalizedCycle);
              errorMessages.push({
                errorLocation: `endpointDependencies`,
                message: `Cyclic dependency detected: ${cyclePath.join(" -> ")}`,
              });
            }
          }
        }
      }

      // Backtrack: remove the current node from path and visited set
      currentPath.pop();
      visited.delete(node);
    }

    // Iterate through all nodes and perform DFS to detect cycles
    for (const node of dependOnMap.keys()) {
      dfsForDetectCycle(node, [], new Set());
    }

    // Return all detected error messages
    return errorMessages;
  }

}