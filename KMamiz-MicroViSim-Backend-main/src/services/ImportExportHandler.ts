import { CCombinedRealtimeData } from "../classes/Cacheable/CCombinedRealtimeData";
import { CEndpointDataType } from "../classes/Cacheable/CEndpointDataType";
import { CEndpointDependencies } from "../classes/Cacheable/CEndpointDependencies";
import { CLabeledEndpointDependencies } from "../classes/Cacheable/CLabeledEndpointDependencies";
import { CLabelMapping } from "../classes/Cacheable/CLabelMapping";
import { CLookBackRealtimeData } from "../classes/Cacheable/CLookBackRealtimeData";
import { CReplicas } from "../classes/Cacheable/CReplicas";
import { CTaggedInterfaces } from "../classes/Cacheable/CTaggedInterfaces";
import { CTaggedSwaggers } from "../classes/Cacheable/CTaggedSwaggers";
import { CTaggedDiffData } from "../classes/Cacheable/CTaggedDiffData";
import { CUserDefinedLabel } from "../classes/Cacheable/CUserDefinedLabel";
import { CTaggedSimulationYAML } from "../classes/Cacheable/CTaggedSimulationYAML";
import { AggregatedDataModel } from "../entities/schema/AggregatedDataSchema";
import { HistoricalDataModel } from "../entities/schema/HistoricalDataSchema";
import { TAggregatedData } from "../entities/TAggregatedData";
import { THistoricalData } from "../entities/THistoricalData";
import DataCache from "./DataCache";
import DispatchStorage from "./DispatchStorage";
import MongoOperator from "./MongoOperator";
import ServiceUtils from "./ServiceUtils";
import KubernetesService from "./KubernetesService";
import { tgz } from "compressing";
import { Readable } from 'stream';
import Logger from "../utils/Logger";


export default class ImportExportHandler {
  private static instance?: ImportExportHandler;
  static getInstance = () => this.instance || (this.instance = new this());
  private constructor() { }

  async exportData() {
    const caches = DataCache.getInstance().export();
    const aggregatedData =
      await MongoOperator.getInstance().getAggregatedData();
    const historicalData =
      await MongoOperator.getInstance().getHistoricalData();
    const json = JSON.stringify([
      ...caches,
      ["AggregatedData", aggregatedData],
      ["HistoricalData", historicalData],
    ]);
    return json;
  }

  async clearData() {
    DataCache.getInstance().clear();
    DataCache.getInstance().register([
      new CLabelMapping(),
      new CEndpointDataType(),
      new CCombinedRealtimeData(),
      new CEndpointDependencies(),
      new CReplicas(),
      new CTaggedInterfaces(),
      new CTaggedSwaggers(),
      new CTaggedDiffData(),
      new CLabeledEndpointDependencies(),
      new CUserDefinedLabel(),
      new CLookBackRealtimeData(),
      new CTaggedSimulationYAML(),
    ]);
    await MongoOperator.getInstance().clearDatabase();
  }


  async importData(importData: [string, any][]) {
    if (!importData) return false;

    await MongoOperator.getInstance().clearDatabase();

    // fix Date being converted into string
    const dataType = importData.find(
      ([name]) => name === "EndpointDataType"
    )![1];
    dataType.forEach((dt: any) =>
      dt.schemas.forEach((s: any) => (s.time = new Date(s.time)))
    );

    DataCache.getInstance().import(importData);
    DataCache.getInstance().register([new CLookBackRealtimeData()]);

    const [, aggregatedData] =
      importData.find(([name]) => name === "AggregatedData") || [];
    const [, historicalData] =
      importData.find(([name]) => name === "HistoricalData") || [];

    await MongoOperator.getInstance().insertMany(
      [aggregatedData as TAggregatedData],
      AggregatedDataModel
    );
    await MongoOperator.getInstance().insertMany(
      historicalData as THistoricalData[],
      HistoricalDataModel
    );

    await DispatchStorage.getInstance().syncAll();
    ServiceUtils.getInstance().updateLabel();
    return true;
  }

  async cloneDataFromProductionService(): Promise<{
    isSuccess: boolean,
    message: string
  }> {
    const productionServiceBaseURL = await KubernetesService.getInstance().getProductionServiceBaseURL();
    const res = await fetch(`${productionServiceBaseURL}/api/v1/data/export`, {
      method: "GET",
      headers: {
        'Accept': 'application/x-tar+gzip',
      },
    });
    if (!res.ok) {
      return {
        isSuccess: false,
        message: 'Failed to reach the KMamiz production environment. No response received.'
      };
    }
    try {
      const buffer = await res.arrayBuffer();
      const chunks: any[] = [];
      const stream = new tgz.UncompressStream();
      stream.on("entry", (_, s) => {
        s.on("data", (chunk: any) => chunks.push(chunk));
        s.on("end", async () => {
          const caches = JSON.parse(
            Buffer.concat(chunks).toString("utf8")
          ) as [string, any][];
          await ImportExportHandler.getInstance().importDataFromProductionEnvironment(
            caches
          );
          return;
        });
      });
      const readableStream = new Readable({
        read() {
          this.push(Buffer.from(buffer));
          this.push(null);
        },
      });
      readableStream.pipe(stream);
      return {
        isSuccess: true,
        message: 'ok'
      };
    } catch (ex) {
      Logger.error(`Failed to clone data from KMamiz production service, simulator data will be empty.`);
      Logger.verbose("", ex);
      return {
        isSuccess: false,
        message: 'An error occurred while cloning data from the KMamiz production service. See the simulator logs for more information.'
      };
    }
  }

  async importDataFromProductionEnvironment(importData: [string, any][]) {
    // HistoricalData and Aggregate data will not be imported
    if (!importData) return false;

    await MongoOperator.getInstance().clearDatabase();

    // fix Date being converted into string
    const dataType = importData.find(
      ([name]) => name === "EndpointDataType"
    )![1];
    dataType.forEach((dt: any) =>
      dt.schemas.forEach((s: any) => (s.time = new Date(s.time)))
    );

    DataCache.getInstance().import(importData);
    DataCache.getInstance().register([new CLookBackRealtimeData()]);

    ServiceUtils.getInstance().updateLabel();
    return true;
  }
}
