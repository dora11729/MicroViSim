import IRequestHandler from "../../entities/TRequestHandler";
import Simulator from "../classes/Simulator";
import SimulationConfigManager from "../classes/SimulationConfigManager";
import ServiceOperator from "../../services/ServiceOperator";
import ImportExportHandler from "../../services/ImportExportHandler";
import multer from "multer";

const upload = multer({ storage: multer.memoryStorage() });

export default class SimulationService extends IRequestHandler {



  constructor() {
    super("simulation");

    this.addRoute(
      "post",
      "/startSimulation",
      async (req, res) => {

        const simConfigYamlFile = req.file;

        if (!simConfigYamlFile) {
          return res.status(400).json({ message: "YAML file is missing." });
        }

        const simConfigYamlString = simConfigYamlFile.buffer.toString("utf-8").trim();
        if (!simConfigYamlString) {
          return res.status(200).json({
            message: "Received an empty YAML. Skipping data retrieval.",
          });
        }

        const { status, message } = await this.processSimulationFromYaml(simConfigYamlString);
        return res.status(status).json({ message });
      },
      [upload.single("file")]
    );

    this.addRoute(
      "get",
      "/generateStaticSimConfig",
      async (_, res) => {
        try {
          const staticYamlStr = SimulationConfigManager.getInstance().generateStaticSimConfig();
          return res.status(200).json({
            staticYamlStr: staticYamlStr,
            message: "ok"
          });
        } catch (err) {
          return res.status(500).json({
            staticYamlStr: '',
            message: `Error while trying to generate static Simulation Yaml:\n${err instanceof Error ? err.message : err}`
          });
        }
      }
    );
  }

  private async processSimulationFromYaml(
    yamlData: string,
  ): Promise<{ status: number; message: string }> {

    const simulateDate = Date.now();  // The time at the start of the simulation.

    try {
      //clear all simulator data first
      await ImportExportHandler.getInstance().clearData();

      //retrieve data from yaml
      const simulationResult = Simulator.getInstance().generateSimulationDataFromConfig(
        yamlData, simulateDate
      );

      if (simulationResult.validationErrorMessage) {
        return {
          status: 400,
          message: simulationResult.validationErrorMessage,
        };
      } else if (simulationResult.convertingErrorMessage) {
        return {
          status: 500,
          message: simulationResult.convertingErrorMessage,
        };
      } else {

        //update to cache and create historical and aggregatedData
        try {
          ServiceOperator.getInstance().updateStaticSimulateDataToCache({
            dependencies: simulationResult.endpointDependencies,
            dataTypes: simulationResult.dataType,
            replicaCounts: simulationResult.basicReplicaCountList,
          });

          await ServiceOperator.getInstance().updateDynamicSimulateData({
            realtimeDataMap: simulationResult.realtimeCombinedDataPerTimeSlotMap,
          });

          return {
            status: 201,
            message: "ok",
          };
        } catch (err) {
          return {
            status: 500,
            message: `Error while caching and creating historical and aggregated data:\n---\n${err instanceof Error ? err.message : err}`,
          };
        }

      }
    } catch (err) {
      return {
        status: 500,
        message: `Error simulate retrive data by YAML:\n---\n${err instanceof Error ? err.message : err}`,
      };
    }
  }

}
