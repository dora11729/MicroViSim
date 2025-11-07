import {
  TFallbackStrategy,
  TSimulationEndpointMetric
} from "../../entities/TSimConfigLoadSimulation";

export class FallbackHandler {
  private _fallbackStrategyInstances: Record<TFallbackStrategy, IErrorPropagationStrategy>;
  private _fallbackStrategyMap: Map<string, IErrorPropagationStrategy>;

  constructor(endpointMetrics: TSimulationEndpointMetric[]) {
    this._fallbackStrategyInstances = {
      "failIfAnyDependentFail": new FailIfAnyDependentFailsStrategy(),
      "failIfAllDependentFail": new FailIfAllDependentsFailStrategy(),
      "ignoreDependentFail": new IgnoreDependentErrorsStrategy(),
    };
    this._fallbackStrategyMap = this.initFallbackStrategyMap(endpointMetrics);
  }

  getEndpointFallbackStrategy(uniqueServiceName: string):IErrorPropagationStrategy {
    return this._fallbackStrategyMap.get(uniqueServiceName) ?? this.getDefaultFallbackStrategy();
  }

  // Default error propagation strategy: the endpoint is considered failed if any of its dependent endpoints fail
  private getDefaultFallbackStrategy(): IErrorPropagationStrategy {
    return this._fallbackStrategyInstances.failIfAnyDependentFail;
  }

  private initFallbackStrategyMap(
    endpointMetrics: TSimulationEndpointMetric[]
  ): Map<string, IErrorPropagationStrategy> {
    const fallbackStrategyInstanceMap = new Map<string, IErrorPropagationStrategy>();

    for (const metric of endpointMetrics) {
      const uniqueEndpointName = metric.uniqueEndpointName!;
      const strategyName = metric.fallbackStrategy;
      const strategyInstance = this._fallbackStrategyInstances[strategyName];
      fallbackStrategyInstanceMap.set(uniqueEndpointName, strategyInstance);
    }

    return fallbackStrategyInstanceMap;
  }
}

interface IErrorPropagationStrategy {
  /**
   * Determines whether to adjust the endpoint status based on errors from dependent endpoints for a given request
   * @param endpointCurrentSuccess - The current success status of the endpoint for the request
   * @param dependentEndpointsSuccessList - The success status list of dependent endpoints for the request
   * @returns The adjusted status of the endpoint (true = success, false = failure)
   */
  propagateError(
    endpointCurrentSuccess: boolean,
    dependentEndpointsSuccessList: boolean[]
  ): boolean;
}

// Endpoint fail if any depend endpoints fails
class FailIfAnyDependentFailsStrategy implements IErrorPropagationStrategy {
  propagateError(endpointCurrentSuccess: boolean, dependentEndpointsSuccessList: boolean[]): boolean {
    if (!endpointCurrentSuccess) return false;
    return !dependentEndpointsSuccessList.includes(false);
  }
}

// Endpoint fail only if all depend endpoints fail
class FailIfAllDependentsFailStrategy implements IErrorPropagationStrategy {
  propagateError(endpointCurrentSuccess: boolean, dependentEndpointsSuccessList: boolean[]): boolean {
    if (!endpointCurrentSuccess) return false; // It has failed on its own
    if (dependentEndpointsSuccessList.length === 0) return true; // No dependency on endpoint, directly successful

    const allFailed = dependentEndpointsSuccessList.every(success => !success);
    return !allFailed;
  }
}

// Depend endpoints errors are not propagated to the parent
class IgnoreDependentErrorsStrategy implements IErrorPropagationStrategy {
  propagateError(endpointCurrentSuccess: boolean, _dependentEndpointsSuccessList: boolean[]): boolean {
    return endpointCurrentSuccess;
  }
}



