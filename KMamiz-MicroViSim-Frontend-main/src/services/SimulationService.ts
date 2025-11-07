import Config from "../../Config";
import YAML from 'yaml';

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

  async retrieveDataBySimulateYaml(simConfigYAML: string) {
    const blob = new Blob([simConfigYAML], { type: 'text/yaml' });
    const formData = new FormData();
    formData.append('file', blob, 'simConfig.yaml');

    const res = await fetch(`${this.prefix}/startSimulation`, {
      method: "POST",
      body: formData,
    });

    const resBody = await res.json();
    return {
      message: typeof resBody.message === 'string'
        ? String(resBody.message)
        : JSON.stringify(resBody.message),
      resStatus: res.status
    };
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
}
