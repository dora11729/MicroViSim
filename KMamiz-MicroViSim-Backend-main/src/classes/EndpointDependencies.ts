import {
  TEndpointDependency,
  TEndpointDependencyCombined,
} from "../entities/TEndpointDependency";
import { TGraphData, TLink, TNode } from "../entities/TGraphData";
import {
  TServiceDependency,
  TServiceLinkInfo,
  TServiceLinkInfoDetail,
} from "../entities/TServiceDependency";
import { TServiceEndpointCohesion } from "../entities/TServiceEndpointCohesion";
import DataCache from "../services/DataCache";
import RiskAnalyzer from "../utils/RiskAnalyzer";
import { CLabelMapping } from "./Cacheable/CLabelMapping";
import GlobalSettings from "../../src/GlobalSettings";

export class EndpointDependencies {
  private readonly _dependencies: TEndpointDependency[];

  private static parseThresholdToMilliseconds = (thresholdStr:string): number => {
    if (!thresholdStr) return 0;
    const regex = /(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?/;
    const match = thresholdStr.match(regex);
    if (!match) return 0;
  
    const days = match[1] ? parseInt(match[1], 10) : 0;
    const hours = match[2] ? parseInt(match[2], 10) : 0;
    const minutes = match[3] ? parseInt(match[3], 10) : 0;
  
    return ((days * 86400) + (hours * 3600) + (minutes * 60)) * 1000;
  }

  private static readonly graphNodeUseStatusThreshold = {
    inActive:EndpointDependencies.parseThresholdToMilliseconds(GlobalSettings.InactiveEndpointThreshold),
    deprecated: EndpointDependencies.parseThresholdToMilliseconds(GlobalSettings.DeprecatedEndpointThreshold),
  }



  constructor(dependencies: TEndpointDependency[]) {
    this._dependencies = EndpointDependencies.filterOutDeprecatedEndpoint(dependencies)
  }

  private static filterOutDeprecatedEndpoint(dependencies: TEndpointDependency[]):TEndpointDependency[]{
    /* 
      If the endpoint's lastTimestamp is less than the deprecatedTimestamp, 
      the endpoint is considered deprecated and will be filtered out of the dependencies. 
    */
    const now = Date.now();
    const deprecatedTimestamp = EndpointDependencies.graphNodeUseStatusThreshold.deprecated === 0 
      ? 0 
      : now - EndpointDependencies.graphNodeUseStatusThreshold.deprecated;
    
    if (deprecatedTimestamp === 0) return dependencies;

    const deprecateduniqueEndpointNames = new Set<string>();
    dependencies = dependencies.filter((dep) => {
      if (dep.lastUsageTimestamp < deprecatedTimestamp) {
        deprecateduniqueEndpointNames.add(dep.endpoint.uniqueEndpointName);
        return false;
      }
      return true;
    });
    dependencies.forEach((dependency) => {
      dependency.dependingBy = dependency.dependingBy.filter((dep) => {
        return !deprecateduniqueEndpointNames.has(dep.endpoint.uniqueEndpointName);
      });
      dependency.dependingOn = dependency.dependingOn.filter((dep) => {
        return !deprecateduniqueEndpointNames.has(dep.endpoint.uniqueEndpointName);
      });
    });

    return dependencies
  }

  toJSON() {
    return this._dependencies.map((dep) => {
      if (dep._id) dep._id = undefined;
      dep.dependingBy = dep.dependingBy.map((d) => {
        delete (d as any)["_id"];
        return d;
      });
      dep.dependingOn = dep.dependingOn.map((d) => {
        delete (d as any)["_id"];
        return d;
      });
      return dep;
    });
  }

  trim() {
    return new EndpointDependencies(
      this._dependencies.map((d): TEndpointDependency => {
        const dOnMap = new Map<string, any>();
        d.dependingOn.forEach((dOn) => {
          const id = `${dOn.distance}\t${dOn.endpoint.uniqueEndpointName}`;
          dOnMap.set(id, dOn);
        });
        const dByMap = new Map<string, any>();
        d.dependingBy.forEach((dBy) => {
          const id = `${dBy.distance}\t${dBy.endpoint.uniqueEndpointName}`;
          dByMap.set(id, dBy);
        });

        return {
          ...d,
          dependingBy: [...dByMap.values()],
          dependingOn: [...dOnMap.values()],
        };
      })
    );
  }

  label() {
    return this._dependencies.map((d): TEndpointDependency => {
      const getEpName = (uniqueName: string) => {
        return DataCache.getInstance()
          .get<CLabelMapping>("LabelMapping")
          .getLabelFromUniqueEndpointName(uniqueName);
      };

      const labelName = getEpName(d.endpoint.uniqueEndpointName);
      const dependingBy = d.dependingBy.map((dep) => {
        return {
          ...dep,
          endpoint: {
            ...dep.endpoint,
            labelName: getEpName(dep.endpoint.uniqueEndpointName),
          },
        };
      });
      const dependingOn = d.dependingOn.map((dep) => {
        return {
          ...dep,
          endpoint: {
            ...dep.endpoint,
            labelName: getEpName(dep.endpoint.uniqueEndpointName),
          },
        };
      });

      return {
        endpoint: {
          ...d.endpoint,
          labelName,
        },
        isDependedByExternal: d.isDependedByExternal,
        lastUsageTimestamp: d.lastUsageTimestamp,
        dependingOn,
        dependingBy,
      };
    });
  }



  toGraphData() {
    const serviceEndpointMap = new Map<string, TEndpointDependency[]>();
    const dependencies = this._dependencies;
    dependencies.forEach((dep) => {
      const uniqueName = `${dep.endpoint.service}\t${dep.endpoint.namespace}`;
      serviceEndpointMap.set(uniqueName, [
        ...(serviceEndpointMap.get(uniqueName) || []),
        dep,
      ]);
    });

    const { nodes: bNodes, links: bLinks } =
      this.createBaseNodesAndLinks(serviceEndpointMap);
    return this.createHighlightNodesAndLinks(
      dependencies,
      bNodes,
      bLinks
    ) as TGraphData;
  }

  private createBaseNodesAndLinks(
    serviceEndpointMap: Map<string, TEndpointDependency[]>
  ) {
    const now = Date.now();
    // If Threshold === 0, it means the threshold is not set. As a result, inactiveTimestamp will be set to 0, which will prevent nodes from being marked as inactive.
    const inactiveTimestamp = EndpointDependencies.graphNodeUseStatusThreshold.inActive === 0 
        ? 0 
        : now - EndpointDependencies.graphNodeUseStatusThreshold.inActive;
    const existLabels = new Set<string>();
    const existLinks = new Set<string>();
    const nodes: TNode[] = [
      // root node (external)
      {
        id: "null",
        group: "null",
        name: "external requests",
        dependencies: [],
        linkInBetween: [],
        usageStatus: "Active"
      },
    ];
    const links: TLink[] = [];
    [...serviceEndpointMap.entries()].forEach(([service, endpoint]) => {
      // service node
      const serviceLastUseTimestamp = Math.max(
        ...endpoint.map((e) => e.lastUsageTimestamp || 0)
      );
      nodes.push({
        id: service,
        group: service,
        name: service.replace("\t", "."),
        dependencies: [],
        linkInBetween: [],
        usageStatus: inactiveTimestamp === 0 || serviceLastUseTimestamp >= inactiveTimestamp ? "Active" : "Inactive"
      });

      endpoint.forEach((e) => {
      const endpointLastUseTimestamp = e.lastUsageTimestamp;
        const id = `${e.endpoint.uniqueServiceName}\t${e.endpoint.method}\t${e.endpoint.labelName}`;
        // endpoint node
        if (!existLabels.has(id)) {
          nodes.push({
            id,
            group: service,
            name: `(${e.endpoint.version}) ${e.endpoint.method} ${e.endpoint.labelName}`,
            dependencies: [],
            linkInBetween: [],
            usageStatus: inactiveTimestamp === 0 || endpointLastUseTimestamp >= inactiveTimestamp ? "Active" : "Inactive"
          });
          existLabels.add(id);
        }

        // service to endpoint links
        if (!existLinks.has(`${service}\t${id}`)) {
          links.push({
            source: service,
            target: id,
          });
          existLinks.add(`${service}\t${id}`);
        }

        // endpoint to endpoint links
        e.dependingOn
          .filter((dep) => dep.distance === 1)
          .forEach((dep) => {
            const depId = `${dep.endpoint.uniqueServiceName}\t${dep.endpoint.method}\t${dep.endpoint.labelName}`;
            if (!existLinks.has(`${id}\t${depId}`)) {
              links.push({
                source: id,
                target: depId,
              });
              existLinks.add(`${id}\t${depId}`);
            }
          });
        if (e.isDependedByExternal) {
          if (!existLinks.has(`null\t${id}`)) {
            links.push({
              source: "null",
              target: id,
            });
            existLinks.add(`null\t${id}`);
          }
        }
        
      });
    });

    return { nodes, links };
  }
  private createHighlightNodesAndLinks(
    dependencies: TEndpointDependency[],
    nodes: TNode[],
    links: TLink[]
  ) {
    const dependencyWithId = dependencies.map((dep) => ({
      ...dep,
      uid: `${dep.endpoint.uniqueServiceName}\t${dep.endpoint.method}\t${dep.endpoint.labelName}`,
      sid: `${dep.endpoint.service}\t${dep.endpoint.namespace}`,
    }));

    nodes = nodes.map((n) => {
      switch (n.id) {
        case "null": // root node
          n.dependencies = dependencyWithId
            .filter((d) => d.dependingBy.length === 0)
            .map(({ uid }) => uid);
          n.linkInBetween = n.dependencies.map((d) => ({
            source: "null",
            target: d,
          }));
          break;
        case n.group: // service node
          n.dependencies = dependencyWithId
            .filter((d) => d.sid === n.id)
            .map(({ uid }) => uid);
          n.linkInBetween = n.dependencies.map((d) => ({
            source: n.id,
            target: d,
          }));
          break;
        default:
          // endpoint node
          // find the node and sort dependingOn & dependingBy with descending distance
          const nodes = dependencyWithId.filter((d) => d.uid === n.id);

          n.linkInBetween = [];
          n.dependencies = [];
          nodes.forEach((node) => {
            const dependingOnSorted = this.sortEndpointInfoByDistanceDesc(
              node.dependingOn
            );
            const dependingBySorted = this.sortEndpointInfoByDistanceDesc(
              node.dependingBy
            );

            // fill in links to highlight
            n.linkInBetween = n.linkInBetween
              .concat(this.mapToLinks(dependingOnSorted, n, links))
              .concat(this.mapToLinks(dependingBySorted, n, links))
              .filter((l) => !!l) as TLink[];
            // fill in nodes to highlight
            n.dependencies = n.dependencies.concat([
              ...new Set(
                this.remapToId(dependingOnSorted).concat(
                  this.remapToId(dependingBySorted)
                )
              ),
            ]);
          });
          n.linkInBetween = [
            ...new Set(
              n.linkInBetween.map((l) => `${l.source}\t\t${l.target}`)
            ),
          ].map((l) => {
            const [source, target] = l.split("\t\t");
            return { source, target };
          });
      }
      return n;
    });
    return { nodes, links };
  }
  private remapToId(list: TEndpointDependencyCombined[]) {
    return list.map(
      ({ endpoint: { uniqueServiceName, method, labelName } }) =>
        `${uniqueServiceName}\t${method}\t${labelName}`
    );
  }
  private sortEndpointInfoByDistanceDesc(list: TEndpointDependencyCombined[]) {
    return [...list].sort((a, b) => b.distance - a.distance);
  }
  private mapToLinks(
    list: TEndpointDependencyCombined[],
    node: TNode,
    links: TLink[]
  ) {
    return list
      .map(
        ({ endpoint: { uniqueServiceName, method, labelName }, type }, i) => {
          const id = `${uniqueServiceName}\t${method}\t${labelName}`;
          const remaining = new Set([
            ...this.remapToId(list.slice(i + 1)),
            node.id,
          ]);
          const from = type === "SERVER" ? "target" : "source";
          const to = type === "SERVER" ? "source" : "target";
          return links.filter((l) => l[from] === id && remaining.has(l[to]));
        }
      )
      .flat();
  }

  toServiceDependencies() {
    const dependencies = this._dependencies;
    // gather all service info from endpointDependencies
    const serviceTemplates = [
      ...dependencies.reduce(
        (prev, { endpoint }) => prev.add(endpoint.uniqueServiceName),
        new Set<string>()
      ),
    ];

    // create service dependencies
    return serviceTemplates.map((uniqueServiceName): TServiceDependency => {
      // find dependencies for the current service
      const dependency = dependencies.filter(
        ({ endpoint }) => endpoint.uniqueServiceName === uniqueServiceName
      );

      // create links info from endpointDependencies
      const linkMap =
        EndpointDependencies.createServiceToLinksMapping(dependency);

      // combine all previous data to create a service dependency
      const [service, namespace, version] = uniqueServiceName.split("\t");
      return {
        service,
        namespace,
        version,
        dependency,
        links: [...linkMap.entries()].map(([uniqueServiceName, info]) => {
          const [service, namespace, version] = uniqueServiceName.split("\t");
          return {
            service,
            namespace,
            version,
            ...info,
            uniqueServiceName,
          };
        }),
        uniqueServiceName,
      };
    });
  }

  private static createServiceToLinksMapping(
    dependency: TEndpointDependency[]
  ) {
    // create links info from endpointDependencies
    const distanceLinkSet = new Set<string>();
    dependency.forEach((dep) => {
      [...dep.dependingOn, ...dep.dependingBy].forEach((dep) => {
        const id = `${dep.endpoint.uniqueServiceName}\t${
          dep.endpoint.method
        }\t${dep.endpoint.labelName!}\t${dep.type}\t${dep.distance}`;
        distanceLinkSet.add(id);
      });
    });

    const detailMap = new Map<string, Map<number, TServiceLinkInfoDetail>>();
    [...distanceLinkSet].map((id) => {
      const [service, namespace, version, , , type, distanceStr] =
        id.split("\t");
      const uniqueServiceName = `${service}\t${namespace}\t${version}`;
      const distance = parseInt(distanceStr);

      const existing =
        detailMap.get(uniqueServiceName) ||
        new Map<number, TServiceLinkInfoDetail>();
      const existingDist = existing.get(distance) || {
        count: 0,
        dependingBy: 0,
        dependingOn: 0,
        distance: distance,
      };
      detailMap.set(
        uniqueServiceName,
        existing.set(distance, {
          count: existingDist.count + 1,
          dependingBy: existingDist.dependingBy + (type === "CLIENT" ? 1 : 0),
          dependingOn: existingDist.dependingOn + (type === "SERVER" ? 1 : 0),
          distance: distance,
        })
      );
    });

    const linkMap = new Map<string, TServiceLinkInfo>();
    [...detailMap.entries()].map(([uniqueServiceName, detailMap]) => {
      const details = [...detailMap.values()];
      linkMap.set(uniqueServiceName, {
        details,
        ...details.reduce(
          (prev, curr) => {
            prev.count += curr.count;
            prev.dependingBy += curr.dependingBy;
            prev.dependingOn += curr.dependingOn;
            return prev;
          },
          { count: 0, dependingBy: 0, dependingOn: 0 }
        ),
      });
    });
    return linkMap;
  }

  toChordData() {
    const nameToId = (uniqueServiceName: string) => {
      const [service, namespace, version] = uniqueServiceName.split("\t");
      return `${service}.${namespace} (${version})`;
    };
    const svcDep = this.toServiceDependencies();
    const links = svcDep
      .flatMap((s) => {
        return s.links.map((l) => ({
          from: s.uniqueServiceName,
          to: l.uniqueServiceName,
          value: l.dependingOn,
        }));
      })
      .filter((l) => l.value > 0);
    const nodeSet = new Set<string>();
    links.forEach((l) => nodeSet.add(l.from).add(l.to));
    return {
      nodes: [...nodeSet].map((n) => ({ id: nameToId(n), name: n })),
      links: links.map((l) => ({
        ...l,
        from: nameToId(l.from),
        to: nameToId(l.to),
      })),
    };
  }

  combineWith(endpointDependencies: EndpointDependencies) {
    const dependencyMap = new Map<
      string,
      {
        endpoint: TEndpointDependency;
        dependingBySet: Set<string>;
        dependingOnSet: Set<string>;
      }
    >();
    this._dependencies.forEach((d) => {
      dependencyMap.set(
        d.endpoint.uniqueEndpointName,
        this.createDependencyMapObject(d)
      );
    });
    endpointDependencies._dependencies.forEach((d) => {
      const existing = dependencyMap.get(d.endpoint.uniqueEndpointName);
      if (existing) {
        d.lastUsageTimestamp = Math.max(d.lastUsageTimestamp,existing.endpoint.lastUsageTimestamp)
        d.dependingBy.forEach((dep) => {
          const id = `${dep.endpoint.uniqueEndpointName}\t${dep.distance}`;
          if (!existing.dependingBySet.has(id)) {
            existing.endpoint.dependingBy.push(dep);
            existing.dependingBySet.add(id);
          }
        });
        d.dependingOn.forEach((dep) => {
          const id = `${dep.endpoint.uniqueEndpointName}\t${dep.distance}`;
          if (!existing.dependingOnSet.has(id)) {
            existing.endpoint.dependingOn.push(dep);
            existing.dependingOnSet.add(id);
          }
        });
      } else {
        dependencyMap.set(
          d.endpoint.uniqueEndpointName,
          this.createDependencyMapObject(d)
        );
      }
    });
    return new EndpointDependencies(
      [...dependencyMap.values()].map(({ endpoint }) => endpoint)
    );
  }


  private createDependencyMapObject(endpoint: TEndpointDependency): {
    endpoint: TEndpointDependency;
    dependingBySet: Set<string>;
    dependingOnSet: Set<string>;
  } {
    return {
      endpoint,
      dependingBySet: new Set(
        endpoint.dependingBy.map(
          (dep) => `${dep.endpoint.uniqueEndpointName}\t${dep.distance}`
        )
      ),
      dependingOnSet: new Set(
        endpoint.dependingOn.map(
          (dep) => `${dep.endpoint.uniqueEndpointName}\t${dep.distance}`
        )
      ),
    };
  }

  toServiceEndpointCohesion() {
    const serviceEndpointMap = new Map<string, TEndpointDependency[]>();
    this._dependencies.forEach((d) => {
      const id = d.endpoint.uniqueServiceName;
      serviceEndpointMap.set(
        id,
        (serviceEndpointMap.get(id) || []).concat([d])
      );
    });

    return [...serviceEndpointMap.entries()].map(
      ([uniqueServiceName, endpoints]): TServiceEndpointCohesion => {
        const serviceUtilizedMap = endpoints
          .flatMap((e) =>
            e.dependingBy
              .filter((d) => d.distance === 1)
              .map((dep) => ({ e, dep }))
          )
          .reduce((map, { e, dep }) => {
            const id = dep.endpoint.uniqueServiceName;
            const source = e.endpoint.uniqueEndpointName;
            return map.set(id, (map.get(id) || new Set()).add(source));
          }, new Map<string, Set<string>>());

        const consumers = [...serviceUtilizedMap.entries()].map(
          ([uniqueServiceName, consumes]) => ({
            uniqueServiceName,
            consumes: consumes.size,
          })
        );

        let endpointUsageCohesion = 0;
        if (endpoints.length > 0 && consumers.length > 0) {
          endpointUsageCohesion = consumers.reduce((acc, cur) => {
            return acc + cur.consumes / endpoints.length;
          }, 0);
          endpointUsageCohesion /= consumers.length;
        }

        return {
          uniqueServiceName,
          totalEndpoints: endpoints.length,
          consumers,
          endpointUsageCohesion,
        };
      }
    );
  }

  toServiceInstability() {
    const serviceDependencies = this.toServiceDependencies();

    return serviceDependencies.map((s) => {
      const { dependingBy, dependingOn } = s.links.reduce(
        (acc, cur) => {
          if (cur.dependingBy > 0) acc.dependingBy++;
          if (cur.dependingOn > 0) acc.dependingOn++;
          return acc;
        },
        { dependingBy: 0, dependingOn: 0 }
      );
      // Logger.info(`dependingOn = ${dependingOn}`)
      // Logger.info(`dependingOn = ${dependingBy}`)
      // Logger.info(`dependingOn + dependingBy = ${dependingOn + dependingBy}`)
      // Logger.info(`(dependingOn + dependingBy === 0) = ${(dependingOn + dependingBy === 0)}`)
      const instability: number = (dependingOn + dependingBy === 0) ? 0 : dependingOn / (dependingOn + dependingBy);
      // Logger.info(`instability = ${instability}`)

      return {
        uniqueServiceName: s.uniqueServiceName,
        name: `${s.service}.${s.namespace} (${s.version})`,
        dependingBy:dependingBy,
        dependingOn:dependingOn,
        instability: instability,
      };
    });
  }

  toServiceCoupling() {
    const serviceDependencies = this.toServiceDependencies();
    const couplingList =
      RiskAnalyzer.AbsoluteCriticalityOfServices(serviceDependencies);
    return couplingList.map((c) => {
      const [service, namespace, version] = c.uniqueServiceName.split("\t");
      return {
        uniqueServiceName: c.uniqueServiceName,
        name: `${service}.${namespace} (${version})`,
        ais: c.ais,
        ads: c.ads,
        acs: c.factor,
      };
    });
  }
}
