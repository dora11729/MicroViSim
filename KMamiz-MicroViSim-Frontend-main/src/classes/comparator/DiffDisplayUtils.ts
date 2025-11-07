import { Dispatch, SetStateAction, useState } from "react";
import { TGraphData, TLink } from "../../entities/TGraphData";
import { Color } from "../ColorUtils";
import { DependencyGraphUtils } from "../DependencyGraphUtils"


import TEndpointDataType from "../../entities/TEndpointDataType";

// to compare two dependency graphs
export type GraphDifferenceInfo = {
  // display at the Overview area
  addedNodeIds: string[];
  deletedNodeIds: string[];
  addedLinkIds: string[];
  deletedLinkIds: string[];
  diffGraphData: TGraphData;

  diffInfoMap: Map<string, EndpointDataTypeDifferenceInfo>;
  changedEndpointNodesId: string[];
};

type TNodeRingType = "added" | "deleted" | "changed" | "default";

const useGraphDifference = (): [
  GraphDifferenceInfo,
  Dispatch<SetStateAction<GraphDifferenceInfo>>
] => {
  const [graphDifference, setGraphDifference] = useState<GraphDifferenceInfo>({
    addedNodeIds: [],
    deletedNodeIds: [],
    addedLinkIds: [],
    deletedLinkIds: [],
    diffGraphData: {
      nodes: [],
      links: []
    },
    diffInfoMap: new Map<string, EndpointDataTypeDifferenceInfo>(),
    changedEndpointNodesId: [],
  });
  return [graphDifference, setGraphDifference];
};

// to compare each endpoint datatype in two dependency graphs
export type EndpointDataTypeDifferenceInfo = {
  isRequestSchemaEqual: boolean;
  responseSchemaDiffStatusCodes: string[];
}


export class DiffDisplayUtils extends DependencyGraphUtils {

  static readonly DiffGraphBasicSettings = {
    // linkDirectionalParticles: 1,
    linkDirectionalArrowRelPos: 1,
    nodeRelSize: 4,
    // nodeAutoColorBy: "group",
    nodePointerAreaPaint: DiffDisplayUtils.PaintNode,
    linkLabel: (d: any) => `${d.source.name} ➔ ${d.target.name}`,
  };

  static CompareTwoGraphData(
    newData: TGraphData,
    oldData: TGraphData,
    oldEndpointDatatypeMap: Record<string, TEndpointDataType>,
    newEndpointDatatypeMap: Record<string, TEndpointDataType>,
    showEndpoint: boolean
  ): GraphDifferenceInfo {
    if (!newData || !oldData) {
      return {
        addedNodeIds: [],
        deletedNodeIds: [],
        addedLinkIds: [],
        deletedLinkIds: [],
        diffGraphData: {
          nodes: [],
          links: []
        },
        diffInfoMap: new Map<string, EndpointDataTypeDifferenceInfo>(),
        changedEndpointNodesId: [],
      }
    } else {
      if (!showEndpoint) {
        newData = DependencyGraphUtils.toServiceDependencyGraph(newData);
        oldData = DependencyGraphUtils.toServiceDependencyGraph(oldData);
      }
      // ids of all nodes
      const nodeIdsInNewData: string[] = newData.nodes.map(node => node.id);
      const nodeIdsInOldData: string[] = oldData.nodes.map(node => node.id);
      const addedNodeIds: Set<string> = new Set(nodeIdsInNewData.filter(id => !nodeIdsInOldData.includes(id)));
      const deletedNodeIds: Set<string> = new Set(nodeIdsInOldData.filter(id => !nodeIdsInNewData.includes(id)));

      // ids of all links excluding external nodes
      const linkIdsInNewData: string[] = newData.links.map(link => DiffDisplayUtils.TLinkToId(link));
      const linkIdsInOldData: string[] = oldData.links.map(link => DiffDisplayUtils.TLinkToId(link));
      const addedLinkIds: Set<string> = new Set(linkIdsInNewData.filter(id => !linkIdsInOldData.includes(id)));
      const deletedLinkIds: Set<string> = new Set(linkIdsInOldData.filter(id => !linkIdsInNewData.includes(id)));

      const mergedNodes = [
        ...newData.nodes,
        ...oldData.nodes
          .filter(node => deletedNodeIds.has(node.id))
      ];

      const mergedLinks = [
        ...newData.links,
        ...oldData.links
          .filter(link => deletedLinkIds.has(DiffDisplayUtils.TLinkToId(link)))
      ];

      const diffGraphData: TGraphData = {
        nodes: mergedNodes,
        links: mergedLinks
      }

      const { diffInfoMap, changedEndpointNodesId } = this.CompareDataTypeDifferenceInfoInTwoGraph(oldEndpointDatatypeMap, newEndpointDatatypeMap);
      // console.log("changedEndpointNodesId=",JSON.stringify(changedEndpointNodesId,null,2));
      // console.log("diffInfoMap=",diffInfoMap);
      // console.log("CompareTwoGraphData result:",{
      //   newData:newData,
      //   oldData:oldData,
      //   linkIdsInNewData: Array.from(linkIdsInNewData),
      //   linkIdsInOldData: Array.from(linkIdsInOldData),
      //   addedNodeIds: Array.from(addedNodeIds),
      //   deletedNodeIds: Array.from(deletedNodeIds),
      //   addedLinkIds: Array.from(addedLinkIds),
      //   deletedLinkIds: Array.from(deletedLinkIds),
      //   diffGraphData:diffGraphData,
      //   diffInfoMap:diffInfoMap,
      //   changedEndpointNodesId:changedEndpointNodesId
      // })

      return {
        addedNodeIds: Array.from(addedNodeIds),
        deletedNodeIds: Array.from(deletedNodeIds),
        addedLinkIds: Array.from(addedLinkIds),
        deletedLinkIds: Array.from(deletedLinkIds),
        diffGraphData: diffGraphData,
        diffInfoMap: diffInfoMap,
        changedEndpointNodesId: changedEndpointNodesId
      }
    }
  }

  private static CompareDataTypeDifferenceInfoInTwoGraph(
    oldEndpointDatatypeMap: Record<string, TEndpointDataType>,
    newEndpointDatatypeMap: Record<string, TEndpointDataType>
  ) {
    // console.log("oldEndpointDatatypeMap=", JSON.stringify(oldEndpointDatatypeMap, null, 2));
    // console.log("newEndpointDatatypeMap=", JSON.stringify(newEndpointDatatypeMap, null, 2));
    if (Object.keys(oldEndpointDatatypeMap).length === 0 || Object.keys(newEndpointDatatypeMap).length === 0) {
      return {
        diffInfoMap: new Map<string, EndpointDataTypeDifferenceInfo>(),
        changedEndpointNodesId: [],
      }
    }
    const diffInfoMap = new Map<string, EndpointDataTypeDifferenceInfo>();
    const changedEndpointNodesId = new Set<string>();
    for (const endpointId in newEndpointDatatypeMap) {
      if (endpointId in oldEndpointDatatypeMap) {
        const oldEndpointDatatype = oldEndpointDatatypeMap[endpointId];
        const newEndpointDatatype = newEndpointDatatypeMap[endpointId];
        const diffInfo: EndpointDataTypeDifferenceInfo = {
          isRequestSchemaEqual: true,
          responseSchemaDiffStatusCodes: []
        };

        // compare requestSchema & requestContentType
        const oldRequestSchema = oldEndpointDatatype.schemas.find(s => s.status.startsWith("2"));
        const newRequestSchema = newEndpointDatatype.schemas.find(s => s.status.startsWith("2"));

        if (oldRequestSchema && newRequestSchema) {
          if (this.normalizeSchemaToCompare(oldRequestSchema.requestSchema) !== this.normalizeSchemaToCompare(newRequestSchema.requestSchema)) {
            diffInfo.isRequestSchemaEqual = false;
          }
        } else if (oldRequestSchema || newRequestSchema) {
          // If one version exists but the other version does not, it is still considered change
          diffInfo.isRequestSchemaEqual = false;
        }

        // Compare responseSchema and responseContentType for each status code
        const allStatuses = new Set<string>();
        oldEndpointDatatype.schemas.forEach(s => allStatuses.add(s.status));
        newEndpointDatatype.schemas.forEach(s => allStatuses.add(s.status));
        // console.log(allStatuses);
        for (const status of allStatuses) {
          const oldResponseSchema = oldEndpointDatatype.schemas.find(s => s.status === status);
          const newResponseSchema = newEndpointDatatype.schemas.find(s => s.status === status);
          // console.log(status)
          // console.log(oldSchema);
          // console.log(newSchema);
          // compare responseSchema

          if (oldResponseSchema && newResponseSchema) {
            if (this.normalizeSchemaToCompare(oldResponseSchema.responseSchema) !== this.normalizeSchemaToCompare(newResponseSchema.responseSchema)) {
              diffInfo.responseSchemaDiffStatusCodes.push(status);
            }
          } else if (oldResponseSchema || newResponseSchema) {
            // If one version exists but the other version does not, it is still considered change
            diffInfo.responseSchemaDiffStatusCodes.push(status);
          }
        }

        diffInfoMap.set(endpointId, diffInfo);

        // If there is any difference in the datatype between the two endpoints, record its id into changedEndpointNodesId
        if (!diffInfo.isRequestSchemaEqual || diffInfo.responseSchemaDiffStatusCodes.length > 0) {
          changedEndpointNodesId.add(endpointId);
        }

      }
    }

    return {
      diffInfoMap: diffInfoMap,
      changedEndpointNodesId: Array.from(changedEndpointNodesId),
    };
  }

  private static normalizeSchemaToCompare(schema?: string): string {
    if (!schema) return "";
    const trimmed = schema.trim();
    const emptySchemas = ["interface Root {\n}", "interface Root {}"];
    if (!trimmed || emptySchemas.includes(trimmed)) {
      return "";
    }
    return trimmed;
  }

  static PaintNodeRingForShowDifference(
    node: any,
    ctx: CanvasRenderingContext2D,
    nodeRingType: TNodeRingType,
    isFaded: boolean
  ) {
    ctx.globalAlpha = isFaded ? 0.15 : 1;
    // add ring just for difference nodes
    if (nodeRingType !== "default") {
      if (nodeRingType == "added") {
        ctx.fillStyle = 'rgba(0, 255, 0, 0.7)';
      }
      else if (nodeRingType == "deleted") {
        ctx.fillStyle = 'rgba(255, 0, 0, 0.7)';
      }
      else if (nodeRingType == "changed") {
        ctx.fillStyle = 'rgba(255, 165, 0, 0.7)';
      }
      const { x, y } = node;
      ctx.beginPath();
      if (node.id === node.group) {
        const r = DiffDisplayUtils.DiffGraphBasicSettings.nodeRelSize * 0.85;
        DiffDisplayUtils.DrawHexagon(x, y, r, ctx);
      } else {
        ctx.arc(
          x,
          y,
          DiffDisplayUtils.DiffGraphBasicSettings.nodeRelSize * 1.45,
          0,
          2 * Math.PI,
          false
        );
      }
      ctx.fill();
    }
    // paint underlying style on top of ring
    const color = Color.generateFromString(node.group);

    DiffDisplayUtils.PaintNode(node, color.hex, ctx);
    ctx.globalAlpha = 1;
  }

  static TLinkToId(link: TLink): string {
    return `${link.source}==>${link.target}`
  }


}

export { useGraphDifference };
