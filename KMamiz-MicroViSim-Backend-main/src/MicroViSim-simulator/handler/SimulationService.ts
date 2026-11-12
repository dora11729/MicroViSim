import IRequestHandler from "../../entities/TRequestHandler";
import Simulator from "../classes/Simulator";
import SimulationConfigManager from "../classes/SimulationConfigManager";
import ServiceOperator from "../../services/ServiceOperator";
import ImportExportHandler from "../../services/ImportExportHandler";
import MongoOperator from "../../services/MongoOperator";
import multer from "multer";
import { TPredictionComparison } from "../entities/TPredictionComparison";
import SimulationJobManager from "../classes/SimulationJob";
import { ISimulationProgress, SimulationCancelledError, SimulationFailedError } from "../entities/TSimulationProgress";

const upload = multer({ storage: multer.memoryStorage() });

export default class SimulationService extends IRequestHandler {

  // The latest run's forecasts, by method; kept in memory only, like the run's own inputs.
  private predictionComparison: TPredictionComparison | null = null;

  constructor() {
    super("simulation");

    // Both change as a run goes, so neither may be served from the 5-second cache the API
    // allows by default; a cached status showed the previous run as just finished.
    // (A new object: the default one is shared by every response.)
    this.addRoute("get", "/predictions", async (_, res) => {
      res.cacheControl = { noStore: true };
      const comparison = this.predictionComparison;
      if (!comparison) {
        return res.json({ dates: [], methods: [], configuredMethod: "", services: [] });
      }
      // The charts show simulated time (Day 1 00:00 on); move the forecasts with them.
      const offset = await MongoOperator.getInstance().getSimulationDisplayOffset();
      res.json(offset === null ? comparison : { ...comparison, dates: comparison.dates.map(date => date - offset) });
    });

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
          return res.status(400).json({ message: "The YAML is empty." });
        }

        // Checked before the run starts, which clears the previous results: a typo in the
        // YAML should not cost them. Validation reads nothing that clearing would remove.
        const { errorMessage, parsedConfig } = SimulationConfigManager.getInstance().handleSimConfig(simConfigYamlString);
        if (!parsedConfig) {
          return res.status(400).json({ message: errorMessage || "The YAML could not be read." });
        }

        // Runs in the background: training can outlast the HTTP request, so the page
        // follows the run through /status instead of waiting on this response.
        const started = SimulationJobManager.getInstance().start(
          progress => this.runSimulation(simConfigYamlString, progress).catch(err => {
            if (err instanceof SimulationFailedError || err instanceof SimulationCancelledError) throw err;
            throw new SimulationFailedError(
              `Error simulate retrive data by YAML:\n---\n${err instanceof Error ? err.message : err}`
            );
          })
        );
        if (!started) {
          return res.status(409).json({ message: "A simulation is already running. Wait for it to finish or cancel it first." });
        }
        return res.status(202).json({ message: "Simulation started." });
      },
      [upload.single("file")]
    );

    this.addRoute("get", "/status", async (_, res) => {
      res.cacheControl = { noStore: true };
      res.json(SimulationJobManager.getInstance().status());
    });

    this.addRoute("post", "/cancel", async (_, res) => {
      const outcome = SimulationJobManager.getInstance().cancel();
      if (outcome === "notRunning") return res.status(409).json({ message: "No simulation is running." });
      if (outcome === "notCancellable") {
        return res.status(409).json({ message: "The results are being saved; the simulation can no longer be cancelled." });
      }
      return res.status(202).json({ message: "Cancelling the simulation." });
    });

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

  // Throws SimulationFailedError with a message for the user, or SimulationCancelledError.
  private async runSimulation(yamlData: string, progress: ISimulationProgress): Promise<void> {
    const simulateDate = Date.now();  // The time at the start of the simulation.
    this.predictionComparison = null;

    progress.stage("validating");
    //clear all simulator data first
    await ImportExportHandler.getInstance().clearData();

    //retrieve data from yaml
    const simulationResult = await Simulator.getInstance().generateSimulationDataFromConfig(
      yamlData, simulateDate, progress
    );
    if (simulationResult.validationErrorMessage) {
      throw new SimulationFailedError(simulationResult.validationErrorMessage);
    }
    if (simulationResult.convertingErrorMessage) {
      throw new SimulationFailedError(simulationResult.convertingErrorMessage);
    }

    progress.stage("saving");
    //update to cache and create historical and aggregatedData
    try {
      ServiceOperator.getInstance().updateStaticSimulateDataToCache({
        dependencies: simulationResult.endpointDependencies,
        dataTypes: simulationResult.dataType,
        replicaCounts: simulationResult.basicReplicaCountList,
      });

      await ServiceOperator.getInstance().updateDynamicSimulateData({
        realtimeDataMap: simulationResult.realtimeCombinedDataPerTimeSlotMap,
        realtimeReplicaCountTimeline: simulationResult.realtimeReplicaCountTimeline,
      });
      this.predictionComparison = simulationResult.predictionComparison ?? null;
    } catch (err) {
      throw new SimulationFailedError(
        `Error while caching and creating historical and aggregated data:\n---\n${err instanceof Error ? err.message : err}`
      );
    }
  }
}
