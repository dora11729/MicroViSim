
import SimulationConfigManager from './SimulationConfigManager';
import SimEndpointDependencyBuilder from './SimEndpointDependencyBuilder';
import LoadSimulationHandler from './LoadSimulation/LoadSimulationHandler';
import {
  TSimulationEndpointDatatype,
  TSimulationNamespace,
  TSimulationResponseBody,
} from "../entities/TSimConfigServiceInfo";

import DataCache from "../../services/DataCache";
import { TRealtimeData } from "../../entities/TRealtimeData";
import { TReplicaCount } from "../../entities/TReplicaCount";
import { TEndpointDependency } from "../../entities/TEndpointDependency";
import { TRequestTypeUpper } from "../../entities/TRequestType";
import EndpointDataType from '../../classes/EndpointDataType';
import { TCombinedRealtimeData } from "../../entities/TCombinedRealtimeData";
import { EndpointDependencies } from "../../classes/EndpointDependencies";
import { RealtimeDataList } from "../../classes/RealtimeDataList";

import { CEndpointDependencies } from "../../classes/Cacheable/CEndpointDependencies";
import Logger from "../../utils/Logger";

type TBaseRealtimeData = Omit<
  TRealtimeData,
  'latency' | 'status' | 'responseBody' | 'responseContentType' | 'timestamp'
>;

type TBaseDataWithResponses = {
  baseData: TBaseRealtimeData,
  responses?: TSimulationEndpointDatatype['responses'],
}

export default class Simulator {
  private static instance?: Simulator;
  static getInstance = () => this.instance || (this.instance = new this());
  private constructor() { };

  generateSimulationDataFromConfig(configYamlString: string, simulateDate: number): {
    validationErrorMessage: string; // error message when validating YAML format
    convertingErrorMessage: string; // error message when converting to realtime data
    endpointDependencies: TEndpointDependency[];
    dataType: EndpointDataType[];
    basicReplicaCountList: TReplicaCount[];
    realtimeCombinedDataPerTimeSlotMap: Map<string, TCombinedRealtimeData[]>;

  } {


    // Validate and preprocess simulation configuration
    const { errorMessage, parsedConfig } =
      SimulationConfigManager.getInstance().handleSimConfig(configYamlString);
    if (!parsedConfig) {
      return {
        validationErrorMessage: errorMessage,
        convertingErrorMessage: "",
        endpointDependencies: [],
        dataType: [],
        basicReplicaCountList: [],
        realtimeCombinedDataPerTimeSlotMap: new Map(),
      };
    }

    const {
      sampleRealTimeDataList,// to extract simulation data types even without traffic
      basicReplicaCountList,
      baseDataMap: EndpointRealTimeBaseDatas
    } = this.collectSampleRealtimeDataAndReplicaCounts(
      parsedConfig.servicesInfo,
      simulateDate
    );

    const {
      endpointDependencies,
      dependOnMapWithCallProbability
    } = SimEndpointDependencyBuilder.getInstance().buildEndpointDependenciesBySimConfig(
      parsedConfig,
      simulateDate
    )
    // console.log(
    //   "dependOnMapWithCallProbability",
    //   JSON.stringify(Object.fromEntries(dependOnMapWithCallProbability), null, 2)
    // );

    let realtimeCombinedDataPerTimeSlotMap: Map<string, TCombinedRealtimeData[]> = new Map();

    const loadSimulationSettings = parsedConfig.loadSimulation;

    if (loadSimulationSettings && loadSimulationSettings.endpointMetrics.length > 0) { //loadSimulationSettings.endpointMetrics.length > 0 means there is traffic.


      realtimeCombinedDataPerTimeSlotMap =
        LoadSimulationHandler.getInstance().generateCombinedRealtimeDataMap(
          loadSimulationSettings,
          dependOnMapWithCallProbability,
          basicReplicaCountList,
          EndpointRealTimeBaseDatas,
          simulateDate
        )
    }

    try {
      return {
        validationErrorMessage: "",
        convertingErrorMessage: "",
        ...this.convertRawToSimulationData(
          sampleRealTimeDataList,
          endpointDependencies
        ),
        basicReplicaCountList,
        realtimeCombinedDataPerTimeSlotMap,
      };
    } catch (err) {
      const errMsg = `${err instanceof Error ? err.message : err}`;
      Logger.error("Failed to convert simulationRawData to simulation data, skipping.");
      Logger.verbose("-detail: ", errMsg);
      return {
        validationErrorMessage: "",
        convertingErrorMessage:
          `Failed to convert simulationRawData to simulation data:\n ${errMsg}`,
        endpointDependencies: [],
        dataType: [],
        basicReplicaCountList: [],
        realtimeCombinedDataPerTimeSlotMap: new Map(),
      };
    }
  }

  private convertRawToSimulationData(
    sampleRealTimeDataList: TRealtimeData[],
    endpointDependencies: TEndpointDependency[],
  ) {
    const sampleCbdata = new RealtimeDataList(sampleRealTimeDataList).toCombinedRealtimeData();
    const dataType = sampleCbdata.extractEndpointDataType();
    const existingDep = DataCache.getInstance()
      .get<CEndpointDependencies>("EndpointDependencies")
      .getData()?.toJSON();
    const newDep = new EndpointDependencies(endpointDependencies);
    const dep = existingDep
      ? new EndpointDependencies(existingDep).combineWith(newDep)
      : newDep;

    return {
      endpointDependencies: dep.toJSON(),
      dataType: dataType,
    }
  }

  private collectSampleRealtimeDataAndReplicaCounts(
    servicesInfo: TSimulationNamespace[],
    simulateDate: number,
  ): {
    sampleRealTimeDataList: TRealtimeData[];
    basicReplicaCountList: TReplicaCount[];
    baseDataMap: Map<string, TBaseDataWithResponses>;
  } {
    const sampleRealTimeDataList: TRealtimeData[] = [];
    const basicReplicaCountList: TReplicaCount[] = [];
    const baseDataMap = new Map<string, TBaseDataWithResponses>();
    const processedUniqueServiceNameSet = new Set<string>();


    for (const ns of servicesInfo) {
      for (const svc of ns.services) {
        for (const ver of svc.versions) {
          const uniqueServiceName = ver.uniqueServiceName!;

          // to avoid duplicate processing of the same service
          if (processedUniqueServiceNameSet.has(uniqueServiceName)) continue;
          processedUniqueServiceNameSet.add(uniqueServiceName);

          // create replicaCount
          basicReplicaCountList.push({
            uniqueServiceName,
            service: svc.serviceName,
            namespace: ns.namespace,
            version: ver.version,
            replicas: ver.replica,
          });

          for (const ep of ver.endpoints) {
            const { method } = ep.endpointInfo;
            const methodUpperCase = method.toUpperCase() as TRequestTypeUpper;

            const baseData: TBaseRealtimeData = {
              uniqueServiceName,
              uniqueEndpointName: ep.uniqueEndpointName!,
              method: methodUpperCase,
              service: svc.serviceName,
              namespace: ns.namespace,
              version: ver.version,
              requestBody: ep.datatype?.requestBody,
              requestContentType: ep.datatype?.requestContentType,
            };

            baseDataMap.set(ep.uniqueEndpointName!, { baseData, responses: ep.datatype?.responses });

            // collect endpoint sample data (fake realtime data)
            const endpointSampleData = this.generateSampleRealtimeDataForEndpoint(
              simulateDate,
              baseData,
              ep.datatype?.responses
            );
            sampleRealTimeDataList.push(...endpointSampleData);
          }
        }
      }
    }

    return { sampleRealTimeDataList, basicReplicaCountList, baseDataMap };
  }

  private generateSampleRealtimeDataForEndpoint(
    simulateDate: number,
    baseData: TBaseRealtimeData,
    responses?: TSimulationResponseBody[],
  ): TRealtimeData[] {
    // Create a response map based on datatype
    const respMap = new Map<string, { body: string; contentType: string }>();
    responses?.forEach(r => {
      respMap.set(String(r.status), {
        body: r.responseBody,
        contentType: r.responseContentType
      });
    });
    const sampleStatuses = [...respMap.keys()];

    const endpointSampleData: TRealtimeData[] = sampleStatuses.map(status => ({
      ...baseData,
      latency: 0,
      timestamp: simulateDate * 1000, // microseconds
      status,
      responseBody: respMap.get(status)?.body,
      responseContentType: respMap.get(status)?.contentType,
    }))

    return endpointSampleData;
  }
}
