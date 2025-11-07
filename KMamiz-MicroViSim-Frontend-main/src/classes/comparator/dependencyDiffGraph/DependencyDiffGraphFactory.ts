import { DiffDisplayUtils, GraphDifferenceInfo } from "../DiffDisplayUtils";

export class DiffDependencyGraphFactory {
  private constructor() { }

  static Create(
    graphDifferenceInfo: GraphDifferenceInfo,
    showDiff: boolean,
    fadedNodeIds: string[] = []
  ) {
    const { addedNodeIds, deletedNodeIds, addedLinkIds, deletedLinkIds, changedEndpointNodesId } = graphDifferenceInfo;
    const getNodeRingType = (nodeId: string): "added" | "deleted" | "changed" | "default" => {
      if (addedNodeIds.includes(nodeId)) return "added";
      if (deletedNodeIds.includes(nodeId)) return "deleted";
      if (changedEndpointNodesId.includes(nodeId)) return "changed";
      return "default";
    };
    const getLinkId = (link: any): string =>
      DiffDisplayUtils.TLinkToId({ source: link.source.id, target: link.target.id });

    const isFadeAllLinks = fadedNodeIds.length > 0;

    if (showDiff) {
      return {
        ...DiffDisplayUtils.DiffGraphBasicSettings,
        linkDirectionalArrowColor: () => `rgba(105, 105, 105, ${isFadeAllLinks ? 0.15 : 1})`,
        linkDirectionalArrowLength: () => 3,
        linkWidth: (link: any) =>
          addedLinkIds.includes(getLinkId(link))
            || deletedLinkIds.includes(getLinkId(link))
            ? 1.5 : 1,
        linkDirectionalParticleWidth: (link: any) =>
          4,
        linkColor: (link: any) => {
          if (addedLinkIds.includes(getLinkId(link))) {
            return `rgba(0, 255, 0, ${isFadeAllLinks ? 0.15 : 1})`;
          }
          if (deletedLinkIds.includes(getLinkId(link))) {
            return `rgba(255, 0, 0, ${isFadeAllLinks ? 0.15 : 1})`;
          }
          return `rgba(0, 0, 0, ${isFadeAllLinks ? 0.15 : 0.2})`;
        },
        linkLineDash: (link: any) => {
          if (deletedLinkIds.includes(getLinkId(link))) {
            return [2, 2];
          }
          return [];
        },
        nodeCanvasObject: (node: any, ctx: any) => {
          const ringType = getNodeRingType(node.id);
          const isFaded = fadedNodeIds.includes(node.id);

          DiffDisplayUtils.PaintNodeRingForShowDifference(
            node,
            ctx,
            ringType,
            isFaded,
          );
        },
        onNodeClick: (node: any) => { },
        onNodeHover: (node: any) => { },
        onLinkClick: (link: any) => { },
        onLinkHover: (link: any) => { },
      };
    } else {
      return {
        ...DiffDisplayUtils.GraphBasicSettings,
        linkDirectionalArrowLength: 3,
        linkWidth: 1,
        linkDirectionalParticleWidth: 4,
        nodeCanvasObject: (node: any, ctx: any) => {
          DiffDisplayUtils.PaintNodeRingForShowDifference(
            node,
            ctx,
            "default",
            false,
          );
        },
        onNodeClick: (node: any) => { },
        onNodeHover: (node: any) => { },
        onLinkClick: (link: any) => { },
        onLinkHover: (link: any) => { },
      };
    }
  }
}
