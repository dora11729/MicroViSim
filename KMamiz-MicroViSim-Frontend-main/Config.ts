type BackendConfig = {
  SimulatorMode: boolean,
}
type WebConfig = {
  apiPrefix: string,

  // some configurations are fetched from the backend
  backendConfig: BackendConfig

}

async function fetchBackendConfig(apiPrefix: string): Promise<BackendConfig>  {
  const path = `${apiPrefix}/configuration/config`;
  const res = await fetch(path);
  const defaultBackendConfig = {
    SimulatorMode:false
  }
  if (!res.ok) return defaultBackendConfig;
  return (await res.json()) as BackendConfig;
}

async function initConfig():Promise<WebConfig> {
  const apiHost = (import.meta.env.VITE_API_HOST as string) || window.location.origin;
  const apiPrefixPath = (import.meta.env.VITE_API_PREFIX as string) || "/api/v1";
  const apiPrefix =  `${apiHost}${apiPrefixPath}`;

  const backendConfig:BackendConfig = await fetchBackendConfig(apiPrefix);

  return {
    apiPrefix,
    backendConfig
  }
}

const Config: WebConfig = await initConfig();

export default Config;
