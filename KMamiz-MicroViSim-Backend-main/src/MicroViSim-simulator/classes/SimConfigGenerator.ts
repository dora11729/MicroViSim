
import yaml from "js-yaml";

import { TSimulationNamespace, TSimulationEndpoint, TSimulationResponseBody } from "../entities/TSimConfigServiceInfo";
import { TSimulationEndpointDependency, TSimulationDependOn } from "../entities/TSimConfigEndpointDependency";
import { TSimulationConfigYAML } from "../entities/TSimConfig";

import { TReplicaCount } from "../../entities/TReplicaCount";
import { TEndpointDependency } from "../../entities/TEndpointDependency";
import { TEndpointDataType } from "../../entities/TEndpointDataType";

import { CEndpointDependencies } from "../../classes/Cacheable/CEndpointDependencies";
import { CEndpointDataType } from "../../classes/Cacheable/CEndpointDataType";
import { CReplicas } from "../../classes/Cacheable/CReplicas";

import DataCache from "../../services/DataCache";

export default class SimConfigGenerator {
  // Retrieve necessary data from kmamiz and convert it into a YAML file that can be used to generate static simulation data
  // (such as software quality metrics, dependency graphs, endpoint data formats, etc.)
  generateSimConfigFromCurrentStaticData() {
    const existingEndpointDependencies = DataCache.getInstance()
      .get<CEndpointDependencies>("EndpointDependencies")
      .getData()?.toJSON() || [];
    const existingReplicaCountList = DataCache.getInstance()
      .get<CReplicas>("ReplicaCounts")
      .getData() || [];
    const existingDataTypes = DataCache.getInstance()
      .get<CEndpointDataType>("EndpointDataType")
      .getData();


    const { servicesInfoYaml, endpointIdMap } = this.buildServicesInfoYaml(
      existingDataTypes.map((d) => d.toJSON()),
      existingReplicaCountList
    );
    const endpointDependenciesYaml = this.buildEndpointDependenciesYaml(existingEndpointDependencies, endpointIdMap);
    const StaticSimulationYaml: TSimulationConfigYAML = {
      servicesInfo: servicesInfoYaml,
      endpointDependencies: endpointDependenciesYaml
    }

    return this.formatEmptyJsonBodiesToMultilineYaml(
      yaml.dump(StaticSimulationYaml, { lineWidth: -1 })
    );
  }

  private formatEmptyJsonBodiesToMultilineYaml(rawYamlStr: string): string {
    //improves readability and makes it easier for users to edit the body manually.
    return rawYamlStr.replace(
      /^(\s*)(requestBody|responseBody): '{}'/gm,
      `$1$2: |-\n$1  {\n\n$1  }`
    );
  }

  private buildServicesInfoYaml(
    dataType: TEndpointDataType[],
    basicReplicaCountList: TReplicaCount[],
  ): {
    servicesInfoYaml: TSimulationNamespace[],
    endpointIdMap: Map<string, string>,
  } {
    const namespacesMap: Record<string, TSimulationNamespace> = {};
    const endpointIdCounterMap = new Map<string, number>();
    const endpointIdMap = new Map<string, string>(); // key: uniqueEndpointName, value: endpointId

    // merge schemas by uniqueEndpointName
    const endpointMap = new Map<string, TEndpointDataType>();
    for (const dt of dataType) {
      const key = dt.uniqueEndpointName;
      if (!endpointMap.has(key)) {
        endpointMap.set(key, {
          uniqueServiceName: dt.uniqueServiceName,
          uniqueEndpointName: dt.uniqueEndpointName,
          service: dt.service,
          namespace: dt.namespace,
          version: dt.version,
          method: dt.method,
          schemas: []
        });
      }
      endpointMap.get(key)!.schemas.push(...dt.schemas);
    }

    for (const type of endpointMap.values()) {
      const {
        uniqueEndpointName,
        service,
        namespace,
        version,
        method,
        schemas
      } = type;

      const url = uniqueEndpointName.split("\t")[4];
      const path = this.getPathFromUrl(url)

      // Initialize namespace
      if (!namespacesMap[namespace]) {
        namespacesMap[namespace] = {
          namespace,
          services: []
        };
      }

      let serviceYaml = namespacesMap[namespace].services.find(
        s => s.serviceName === service
      );
      if (!serviceYaml) {
        serviceYaml = {
          serviceName: service,
          versions: []
        };
        namespacesMap[namespace].services.push(serviceYaml);
      }

      let versionYaml = serviceYaml.versions.find(
        v => v.version === version
      );
      if (!versionYaml) {
        versionYaml = {
          version,
          replica: 1,
          endpoints: []
        };
        serviceYaml.versions.push(versionYaml);
      }

      const responses: TSimulationResponseBody[] = schemas.map(schema => ({
        status: schema.status,
        responseContentType: schema.responseContentType || "",
        responseBody:
          schema.responseContentType === "application/json"
            ? this.convertSampleToUserDefinedType(schema.responseSample || {})
            : this.convertSampleToUserDefinedType({}),
      }));

      const endpointIdPrefix = `${namespace}-${service}-${version}-${method.toLowerCase()}-ep`;
      const serialNumber = (endpointIdCounterMap.get(endpointIdPrefix) || 1);
      const endpointId = `${endpointIdPrefix}-${serialNumber}`;
      endpointIdMap.set(uniqueEndpointName, endpointId);
      endpointIdCounterMap.set(endpointIdPrefix, serialNumber + 1);

      const endpoint: TSimulationEndpoint = {
        endpointId: endpointId,
        endpointInfo: {
          path,
          method
        },
        datatype: {
          requestContentType: schemas[0]?.requestContentType || "",
          requestBody:
            schemas[0]?.requestContentType === "application/json"
              ? this.convertSampleToUserDefinedType(schemas[0]?.requestSample || {})
              : this.convertSampleToUserDefinedType({}),
          responses
        }
      };
      versionYaml.endpoints.push(endpoint);
    }

    // Update replica counts to servicesInfoYaml
    for (const replica of basicReplicaCountList) {
      const { uniqueServiceName, replicas, namespace, version } = replica;
      const [serviceName] = uniqueServiceName.split("\t");

      const namespaceYaml = namespacesMap[namespace];
      if (!namespaceYaml) continue;

      const serviceYaml = namespaceYaml.services.find(
        s => s.serviceName === serviceName
      );
      if (!serviceYaml) continue;

      const versionYaml = serviceYaml.versions.find(
        v => v.version === version
      );
      if (!versionYaml) continue;

      versionYaml.replica = replicas;
    }

    return {
      servicesInfoYaml: Object.values(namespacesMap),
      endpointIdMap: endpointIdMap
    };
  }

  private buildEndpointDependenciesYaml(
    endpointDependencies: TEndpointDependency[],
    endpointIdMap: Map<string, string>
  ): TSimulationEndpointDependency[] {
    const result: TSimulationEndpointDependency[] = [];

    endpointDependencies.forEach(dep => {
      const fromKey = dep.endpoint.uniqueEndpointName;
      const fromId = endpointIdMap.get(fromKey);
      if (!fromId) return;

      const dependOn: TSimulationDependOn[] = [];

      dep.dependingOn.forEach(d => {
        if (d.distance !== 1) return;

        const toKey = d.endpoint.uniqueEndpointName;
        const toId = endpointIdMap.get(toKey);
        if (!toId) return;

        dependOn.push({
          endpointId: toId,
        });
      });

      if (dependOn.length === 0) return;

      result.push({
        endpointId: fromId,
        dependOn,
        isExternal: dep.isDependedByExternal
      });
    });

    return result;
  }

  // Convert the requestSample in endpointDataType to UserDefinedType in yaml
  private convertSampleToUserDefinedType(obj: any, indentLevel = 0): string {
    if (JSON.stringify(obj) === '{}') return '{}';
    const indent = '  '.repeat(indentLevel);
    const nextIndent = '  '.repeat(indentLevel + 1);

    if (Array.isArray(obj)) {
      if (obj.length > 0) {
        const elementType = this.convertSampleToUserDefinedType(obj[0], indentLevel);
        return `${elementType}[]`;
      } else {
        return 'any[]';
      }
    } else if (obj !== null && typeof obj === 'object') {
      const properties: string[] = [];
      const keys = Object.keys(obj);
      if (keys.length === 0) {
        return '';
      }

      // Sort the object's keys in alphabetical order (for easier comparison with the interfaces generated by kmamiz)
      const sortedKeys = keys.sort();

      for (const key of sortedKeys) {
        const type = this.convertSampleToUserDefinedType(obj[key], indentLevel + 1);
        properties.push(`${nextIndent}${key}: ${type}`);
      }

      return `{\n${properties.join(',\n')}\n${indent}}`;
    } else if (typeof obj === 'string') {
      return 'string';
    } else if (typeof obj === 'number') {
      return 'number';
    } else if (typeof obj === 'boolean') {
      return 'boolean';
    } else {
      return 'null';
    }
  }

  private getPathFromUrl(url: string) {
    try {
      return new URL(url).pathname;
    } catch {
      return "/";
    }
  }
}