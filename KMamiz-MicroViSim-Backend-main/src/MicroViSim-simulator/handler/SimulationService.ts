import IRequestHandler from "../../entities/TRequestHandler";
import Simulator from "../classes/Simulator";
import SimulationConfigManager from "../classes/SimulationConfigManager";
import ServiceOperator from "../../services/ServiceOperator";
import ImportExportHandler from "../../services/ImportExportHandler";
import multer from "multer";
import YAML from "yamljs";

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

    this.addRoute(
      "post",
      "/uploadDataset",
      async (req, res) => {
        const file = req.file;
        if (!file) return res.status(400).json({ message: "File is missing." });

        try {
          const formData = new FormData();
          const blob = new Blob([new Uint8Array(file.buffer)], { type: file.mimetype });
          formData.append("file", blob, file.originalname);

          const mlServiceUrl = process.env.ML_SERVICE_URL ?? "http://localhost:8000";
          const mlRes = await fetch(`${mlServiceUrl}/uploadDataset`, {
            method: "POST",
            body: formData,
          });

          const mlBody = await mlRes.json();
          if (mlRes.ok) {
            return res.status(200).json({ message: mlBody.message });
          } else {
            return res.status(mlRes.status).json({ message: mlBody.detail ?? "Upload failed." });
          }
        } catch (err) {
          return res.status(500).json({
            message: `Error forwarding dataset: ${err instanceof Error ? err.message : err}`
          });
        }
      },
      [upload.single("file")]
    );
  }

  private async processSimulationFromYaml(
    yamlData: string,
  ): Promise<{ status: number; message: string }> {

    const simulateDate = Date.now();  // The time at the start of the simulation.

    try {
      //clear all simulator data first
      await ImportExportHandler.getInstance().clearData();

      // Parse YAML and extract which models are used
      const parsedConfig = YAML.parse(yamlData);
      const modelsToTrain = this.extractModelsFromConfig(parsedConfig);

      if (modelsToTrain.length > 0) {
        const mlServiceUrl = process.env.ML_SERVICE_URL ?? "http://localhost:8000";
        const trainRes = await fetch(`${mlServiceUrl}/train`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ models: modelsToTrain }),
        });

        if (!trainRes.ok) {
          const body = await trainRes.json();
          // dataset 不存在時只 warn，不中斷模擬
          if (trainRes.status === 404) {
            console.warn("[SimulationService] No dataset found, skipping training.");
          } else {
            return { status: 500, message: `Training failed: ${body.detail}` };
          }
        }
      }

      //retrieve data from yaml
      const simulationResult = await Simulator.getInstance().generateSimulationDataFromConfig(
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
          console.log("realtimeReplicaCountTimeline: ", simulationResult.realtimeReplicaCountTimeline);
          ServiceOperator.getInstance().updateStaticSimulateDataToCache({
            dependencies: simulationResult.endpointDependencies,
            dataTypes: simulationResult.dataType,
            replicaCounts: simulationResult.basicReplicaCountList,
          });

          await ServiceOperator.getInstance().updateDynamicSimulateData({
            realtimeDataMap: simulationResult.realtimeCombinedDataPerTimeSlotMap,
            realtimeReplicaCountTimeline: simulationResult.realtimeReplicaCountTimeline,
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

  // find out which models are used in the config, so that we know which model(s) to train before simulation
  private extractModelsFromConfig(parsedConfig: any): string[] {
    const models = new Set<string>();
    const serviceMetrics = parsedConfig?.loadSimulation?.serviceMetrics ?? [];
    for (const ns of serviceMetrics) {
      for (const svc of ns.services ?? []) {
        for (const ver of svc.versions ?? []) {
          const model = ver.autoScaling?.model;
          if (model) models.add(model);
        }
      }
    }
    return Array.from(models);
  }
}
