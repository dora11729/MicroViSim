import IRequestHandler from "../entities/TRequestHandler";
import { CTaggedDiffData } from "../classes/Cacheable/CTaggedDiffData";
import { TTaggedDiffData} from "../entities/TTaggedDiffData";
import DataCache from "../services/DataCache";
import GlobalSettings from "../GlobalSettings";
import KubernetesService from "../services/KubernetesService";
import GraphService from "./GraphService";
import DataService from "./DataService";

export default class ComparatorService extends IRequestHandler {
  private graphHandler: GraphService;
  private dataHandler: DataService;

  constructor() {
    super("comparator");
    this.graphHandler = new GraphService();
    this.dataHandler = new DataService();


    this.addRoute("get", "/tags", async (req, res) => {
      req = req; // to aviod compile error: 'req' is declared but its value is never read"
      res.json(this.getTagsOfDiffData());
    });

    this.addRoute("get", "/diffData", async (req, res) => {
      const { tag } = req.query as { tag: string };
      const decodedTag = tag && decodeURIComponent(tag);

      res.json(await this.getTaggedDiffData(decodedTag));
    });

    this.addRoute("post", "/diffData", async (req, res) => {
      const { tag } = req.body as {
        tag: string;
      };
      if (!tag) res.sendStatus(400);
      else {
        const graphData = await this.graphHandler.getDependencyGraph();
        const cohesionData = this.graphHandler.getServiceCohesion();
        const couplingData = this.graphHandler.getServiceCoupling();
        const instabilityData = this.graphHandler.getServiceInstability();
        const endpointDataTypeMap = await this.dataHandler.getEndpointDataTypesMap(graphData.nodes.map(node => node.id));

        if (!graphData || !cohesionData || !couplingData || !instabilityData || !endpointDataTypeMap) {
          res.sendStatus(500);
        } else {
          if (GlobalSettings.SimulatorMode) {
            // the kmamiz service which in production mode will append a diffData
            try {
              const productionServiceBaseURL = await KubernetesService.getInstance().getProductionServiceBaseURL();
              const tagged: TTaggedDiffData = {
                tag: `[from Simulator] ${tag}`,
                graphData: graphData,
                cohesionData: cohesionData,
                couplingData: couplingData,
                instabilityData: instabilityData,
                endpointDataTypesMap: endpointDataTypeMap,
              }
              const resFromProductionMode = await fetch(`${productionServiceBaseURL}/api/v1/comparator/diffData/simulator`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(tagged),
              });
              if (!resFromProductionMode.ok) {
                const errorText = await resFromProductionMode.text();
                return res.status(500).json({ message: errorText });
              } else {
                res.sendStatus(200);
              }
            } catch (err) {
              console.error("Error calling kmamiz:", err);
              res.sendStatus(500);
            }
          } else {
            this.addTaggedDiffData({
              tag: tag,
              graphData: graphData,
              cohesionData: cohesionData,
              couplingData: couplingData,
              instabilityData: instabilityData,
              endpointDataTypesMap: endpointDataTypeMap
            });
            res.sendStatus(200);
          }
        }
      }
    });

    if (!GlobalSettings.SimulatorMode) {
      this.addRoute("post", "/diffData/simulator", async (req, res) => {
        const tagged = req.body as TTaggedDiffData;
        if (!tagged) res.sendStatus(400);
        else {
          this.addTaggedDiffData(tagged);
          res.sendStatus(200);
        }
      });
    }

    this.addRoute("delete", "/diffData", async (req, res) => {
      const { tag } = req.body as {
        tag: string;
      };
      if (!tag) res.sendStatus(400);
      else {
        this.deleteTaggedDiffData(tag);
        res.sendStatus(200);
      }
    });
  }

  getTagsOfDiffData(): { tag: string; time: number }[] {
    return DataCache.getInstance()
      .get<CTaggedDiffData>("TaggedDiffDatas")
      .getTagsWithTime();
  }

  addTaggedDiffData(tagged: TTaggedDiffData) {
    DataCache.getInstance()
      .get<CTaggedDiffData>("TaggedDiffDatas")
      .add(tagged);
  }

  deleteTaggedDiffData(tag: string) {
    DataCache.getInstance()
      .get<CTaggedDiffData>("TaggedDiffDatas")
      .delete(tag);
  }

  async getTaggedDiffData(tag: string):Promise<TTaggedDiffData> {
    if (tag) {
      const diffData = DataCache.getInstance()
        .get<CTaggedDiffData>("TaggedDiffDatas")
        .getDataByTag(tag);

      const endpointGraph = diffData?.graphData || this.graphHandler.getEmptyGraphData();
      const endpointDataTypesMap = diffData?.endpointDataTypesMap || {};

      return {
        tag:tag,
        graphData:endpointGraph,
        cohesionData: diffData?.cohesionData || [],
        couplingData: diffData?.couplingData || [],
        instabilityData: diffData?.instabilityData || [],
        endpointDataTypesMap: endpointDataTypesMap,
      };
    } else {// latest version
      const endpointGraph = await this.graphHandler.getDependencyGraph();
      const nodeIds = endpointGraph.nodes
        .filter((node) => node.id !== node.group)
        .map((node) => node.id);
      const endpointDataTypesMap = await this.dataHandler.getEndpointDataTypesMap(nodeIds);

      return {
        tag:tag,
        graphData:endpointGraph,
        cohesionData: this.graphHandler.getServiceCohesion(),
        couplingData: this.graphHandler.getServiceCoupling(),
        instabilityData: this.graphHandler.getServiceInstability(),
        endpointDataTypesMap: endpointDataTypesMap,
      };
    }
  }

}
