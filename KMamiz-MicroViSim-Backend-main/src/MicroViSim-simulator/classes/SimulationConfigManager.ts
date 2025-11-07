import {
  TSimulationConfigYAML,
  simulationConfigYAMLSchema,
} from "../entities/TSimConfig";
import { TSimulationNamespace } from "../entities/TSimConfigServiceInfo";
import { TServiceInfoDefinitionContext } from "../entities/TServiceInfoDefinitionContext";

import SimConfigGenerator from "./SimConfigGenerator";
import yaml from "js-yaml";
import { TSimConfigValidationError } from "../entities/TSimConfigValidationError";

import SimConfigServicesInfoValidator from "./SimConfigValidator/SimConfigServicesInfoValidator";
import SimConfigEndpointDependenciesValidator from "./SimConfigValidator/SimConfigEndpointDependenciesValidator";
import SimConfigLoadSimulationValidator from "./SimConfigValidator/SimConfigLoadSimulationValidator";

import SimConfigServicesInfoPreprocessor from "./SimConfigPreprocessor/SimConfigServicesInfoPreprocessor";
import SimConfigEndpointDependenciesPreprocessor from "./SimConfigPreprocessor/SimConfigEndpointDependenciesPreprocessor";
import SimConfigLoadSimulationPreprocessor from "./SimConfigPreprocessor/SimConfigLoadSimulationPreprocessor";

export default class SimulationConfigManager {
  private static instance?: SimulationConfigManager;
  static getInstance = () => this.instance || (this.instance = new this());

  // validators
  private servicesInfoValidator: SimConfigServicesInfoValidator;
  private endpointDependenciesValidator: SimConfigEndpointDependenciesValidator;
  private loadSimulationValidator: SimConfigLoadSimulationValidator;

  // preprocessors
  private servicesInfoPreprocessor: SimConfigServicesInfoPreprocessor;
  private endpointDependenciesPreprocessor: SimConfigEndpointDependenciesPreprocessor;
  private loadSimulationPreprocessor: SimConfigLoadSimulationPreprocessor;

  // generator
  private generator: SimConfigGenerator;

  private constructor() {
    //validators
    this.servicesInfoValidator = new SimConfigServicesInfoValidator();
    this.endpointDependenciesValidator = new SimConfigEndpointDependenciesValidator();
    this.loadSimulationValidator = new SimConfigLoadSimulationValidator();

    // preprocessors
    this.servicesInfoPreprocessor = new SimConfigServicesInfoPreprocessor();
    this.endpointDependenciesPreprocessor = new SimConfigEndpointDependenciesPreprocessor();
    this.loadSimulationPreprocessor = new SimConfigLoadSimulationPreprocessor();

    // generator
    this.generator = new SimConfigGenerator();
  };

  handleSimConfig(yamlString: string): {
    errorMessage: string;
    parsedConfig: TSimulationConfigYAML | null;  // Parsed YAML object if successful, else null
  } {

    if (!yamlString.trim()) {
      return {
        errorMessage: "",
        parsedConfig: null,
      };
    }
    try {
      // Parse YAML and validate it using Zod schema
      const parsedConfig = yaml.load(yamlString) as TSimulationConfigYAML;
      const schemaValidationResult = simulationConfigYAMLSchema.safeParse(parsedConfig);
      if (!schemaValidationResult.success) {
        return {
          errorMessage: [
            "Failed to parse simulation configuration file:",
            ...schemaValidationResult.error.errors.map((e) => {
              const errorLocation = e.path.join(".");
              return errorLocation
                ? `[Location] ${errorLocation}  [Error] ${e.message}`
                : e.message;
            })
          ].join("\n---\n"),
          parsedConfig: null,
        };
      }
      const parsedConfigAfterZod = schemaValidationResult.data;

      // validate and preprocess parsed config after Zod 
      const validationAndPreprocessingErrors: TSimConfigValidationError[] = this.validationAndPreprocessing(parsedConfigAfterZod);
      if (validationAndPreprocessingErrors.length) {
        return {
          errorMessage: [
            "Failed to validate and preprocess simulation configuration file:",
            ...validationAndPreprocessingErrors.map(e => `[Location] ${e.errorLocation}  [Error] ${e.message}`)
          ].join("\n---\n"),
          parsedConfig: null,
        };
      };
      // console.log("parsedConfig = ",JSON.stringify(parsedConfig,null,2))
      // console.log("parsedConfig = ", yaml.dump(parsedConfigAfterZod))
      // success
      return {
        errorMessage: "",
        parsedConfig: parsedConfigAfterZod,
      }
    } catch (e) {
      return {
        errorMessage: `Failed to handle simulation configuration file(Unexpected error occurred):\n---\n${e instanceof Error ? e.message : e}`,
        parsedConfig: null,
      };
    }
  }


  private validationAndPreprocessing(parsedConfig: TSimulationConfigYAML): TSimConfigValidationError[] {
    // validate and preprocess servicesInfo
    let errorMessages: TSimConfigValidationError[] = [];
    errorMessages = this.servicesInfoValidator.validate(parsedConfig.servicesInfo);
    if (errorMessages.length) return errorMessages;
    errorMessages = this.servicesInfoPreprocessor.preprocess(parsedConfig.servicesInfo);
    if (errorMessages.length) return errorMessages;

    // Provide the service and endpoint information defined in servicesInfo for validating endpointDependencies and loadSimulation. 
    const endpointIdToUniqueNameMap = this.getEndpointIdToUniqueNameMap(parsedConfig.servicesInfo);
    const allDefinedEndpointIds = new Set(endpointIdToUniqueNameMap.keys());
    const uniqueServiceNameToEndpointIdMap = this.getUniqueServiceNameToEndpointIdMap(parsedConfig.servicesInfo);
    const allDefinedUniqueServiceNames = new Set(uniqueServiceNameToEndpointIdMap.keys());
    const serviceInfoDefinitionContext: TServiceInfoDefinitionContext = {
      endpointIdToUniqueNameMap: endpointIdToUniqueNameMap,
      allDefinedEndpointIds: allDefinedEndpointIds,
      uniqueServiceNameToEndpointIdMap: uniqueServiceNameToEndpointIdMap,
      allDefinedUniqueServiceNames: allDefinedUniqueServiceNames,
    }

    // validate and preprocess endpointDependencies
    errorMessages = this.endpointDependenciesValidator.validate(
      parsedConfig.endpointDependencies,
      serviceInfoDefinitionContext
    );
    if (errorMessages.length) return errorMessages;
    errorMessages = this.endpointDependenciesPreprocessor.preprocess(
      parsedConfig.endpointDependencies,
      serviceInfoDefinitionContext
    )
    if (errorMessages.length) return errorMessages;

    // validate and preprocess loadSimulation
    if (parsedConfig.loadSimulation) {
      errorMessages = this.loadSimulationValidator.validate(
        parsedConfig.loadSimulation,
        serviceInfoDefinitionContext
      );
      if (errorMessages.length) return errorMessages;
      errorMessages = this.loadSimulationPreprocessor.preprocess(
        parsedConfig.loadSimulation,
        serviceInfoDefinitionContext
      );
      if (errorMessages.length) return errorMessages;
    }
    // If no errors found, return an empty array.
    return [];
  }

  private getEndpointIdToUniqueNameMap(servicesInfoConfig: TSimulationNamespace[]) {
    // key: endpointId, value: uniqueEndpointName
    const endpointIdUniqueNameMap = new Map<string, string>();

    servicesInfoConfig.forEach(ns =>
      ns.services.forEach(svc =>
        svc.versions.forEach(ver =>
          ver.endpoints.forEach(ep => {
            if (!endpointIdUniqueNameMap.has(ep.endpointId)) {
              endpointIdUniqueNameMap.set(ep.endpointId, ep.uniqueEndpointName!);
            }
          })
        )
      )
    );
    return endpointIdUniqueNameMap;
  }

  private getUniqueServiceNameToEndpointIdMap(
    servicesInfoConfig: TSimulationNamespace[]
  ): Map<string, Set<string>> {
    //return type: Map where key: uniqueServiceName → Set(EndpointId)
    const uniqueServiceNameToEndpointIdMap = new Map<string, Set<string>>();
    servicesInfoConfig.forEach(ns => {
      ns.services.forEach(svc => {
        svc.versions.forEach(ver => {
          const uniqueServiceName = ver.uniqueServiceName!;
          const endpointIds = ver.endpoints.map(e => e.endpointId);
          uniqueServiceNameToEndpointIdMap.set(uniqueServiceName, new Set(endpointIds));
        });
      });
    });
    return uniqueServiceNameToEndpointIdMap;
  }

  generateStaticSimConfig(): string {
    return this.generator.generateSimConfigFromCurrentStaticData();
  }
}

