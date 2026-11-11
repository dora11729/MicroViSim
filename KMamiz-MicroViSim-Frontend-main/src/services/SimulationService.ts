import Config from "../../Config";
import YAML from 'yaml';
import { DataView } from "./DataView";
import { TPredictionComparison } from "../entities/TPredictionComparison";
import { TSimulationJobStatus } from "../entities/TSimulationJob";

export default class SimulationService {
  private static instance?: SimulationService;
  static getInstance = () => this.instance || (this.instance = new this());
  private constructor() { }

  private readonly prefix = `${Config.apiPrefix}/simulation`;

  private async get<T>(path: string) {
    const res = await fetch(path);
    if (!res.ok) return null;
    return (await res.json()) as T;
  }

  // The latest run's forecasts by method; polled so a new run shows up without a reload.
  subscribeToPredictionComparison(next: (data?: TPredictionComparison) => void) {
    return DataView.getInstance().subscribe<TPredictionComparison>(
      `${this.prefix}/predictions`,
      (_, data) => next(data)
    );
  }

  // Starts a run in the background (202); 409 when one is already running. The run is
  // followed through getSimulationStatus().
  async startSimulation(simConfigYAML: string): Promise<{ started: boolean; alreadyRunning: boolean; message: string }> {
    const blob = new Blob([simConfigYAML], { type: 'text/yaml' });
    const formData = new FormData();
    formData.append('file', blob, 'simConfig.yaml');
    try {
      const res = await fetch(`${this.prefix}/startSimulation`, {
        method: "POST",
        body: formData,
      });
      const resBody = await res.json().catch(() => ({}));
      const message = typeof resBody.message === 'string'
        ? resBody.message
        : resBody.message !== undefined ? JSON.stringify(resBody.message) : `HTTP ${res.status}`;
      return { started: res.status === 202, alreadyRunning: res.status === 409, message };
    } catch (err) {
      return { started: false, alreadyRunning: false, message: `Cannot reach the simulator backend: ${err}` };
    }
  }

  // null when the backend cannot be reached. Never from the browser cache: the status
  // changes from one poll to the next.
  async getSimulationStatus(): Promise<TSimulationJobStatus | null> {
    try {
      const res = await fetch(`${this.prefix}/status`, { cache: "no-store" });
      return res.ok ? (await res.json()) as TSimulationJobStatus : null;
    } catch {
      return null;
    }
  }

  async cancelSimulation(): Promise<{ accepted: boolean; message: string }> {
    try {
      const res = await fetch(`${this.prefix}/cancel`, { method: "POST" });
      const resBody = await res.json().catch(() => ({}));
      return { accepted: res.status === 202, message: resBody.message ?? `HTTP ${res.status}` };
    } catch (err) {
      return { accepted: false, message: `Cannot reach the simulator backend: ${err}` };
    }
  }


  async generateSimConfigFromCurrentStaticData() {
    const path = `${this.prefix}/generateStaticSimConfig`;
    return await SimulationService.getInstance().get<
      {
        staticYamlStr: string,
        message: string
      }
    >(path) || {
      staticYamlStr: '',
      message: 'Error while trying to fetching static Simulation Yaml, Please check the response details for more information.'
    };
  }

  async uploadTrainingDataset(formData: FormData): Promise<{ isSuccess: boolean; message: string }> {
  try {
    const res = await fetch(`${this.prefix}/uploadDataset`, {
      method: 'POST',
      body: formData,
    });
    if (res.ok) {
      return { isSuccess: true, message: 'ok' };
    } else {
      const text = await res.text();
      return { isSuccess: false, message: text };
    }
  } catch (error) {
    return { isSuccess: false, message: String(error) };
  }
}
}
