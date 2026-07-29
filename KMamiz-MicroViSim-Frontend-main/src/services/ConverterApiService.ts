import Config from "../../Config";
import {
  ConverterResult,
  ConverterRunOptions,
  K6ConverterConfig,
} from "../entities/TConverter";

export default class ConverterApiService {
  private static instance?: ConverterApiService;
  static getInstance = () => this.instance || (this.instance = new this());

  private readonly prefix = `${Config.apiPrefix}/converter`;

  async convertK6(csvFile: File, config: K6ConverterConfig): Promise<string> {
    const form = new FormData();
    form.append("csv", csvFile);
    form.append("config", JSON.stringify(config));

    const res = await fetch(`${this.prefix}/convert-k6`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error ?? "k6 conversion failed");
    }
    const { csv } = await res.json();
    return csv as string;
  }

  async run(csvFile: File, options: ConverterRunOptions): Promise<ConverterResult> {
    const form = new FormData();
    form.append("csv", csvFile);
    form.append("options", JSON.stringify(options));

    const res = await fetch(`${this.prefix}/run`, { method: "POST", body: form });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error ?? "Converter failed");
    }
    return res.json();
  }

  async runPipeline(
    csvFile: File,
    isK6Format: boolean,
    options: ConverterRunOptions,
    k6Config: K6ConverterConfig,
  ): Promise<{ result: ConverterResult; standardCsv?: string }> {
    if (isK6Format) {
      const standardCsv = await this.convertK6(csvFile, k6Config);
      const blob = new Blob([standardCsv], { type: "text/csv" });
      const standardFile = new File([blob], "converted.csv", { type: "text/csv" });
      const result = await this.run(standardFile, options);
      return { result, standardCsv };
    }

    const result = await this.run(csvFile, options);
    return { result };
  }
}
