export default class SimulatorUtils {



  static generateUniqueServiceName(serviceName: string, namespace: string, serviceVersion: string) {
    const trimmedServiceName = serviceName.trim();
    const trimmedNamespace = namespace.trim();
    const trimmedServiceVersion = serviceVersion.trim();
    return `${trimmedServiceName}\t${trimmedNamespace}\t${trimmedServiceVersion}`;
  }
  static generateUniqueServiceNameWithoutVersion(serviceName: string, namespace: string) {
    const trimmedServiceName = serviceName.trim();
    const trimmedNamespace = namespace.trim();
    return `${trimmedServiceName}\t${trimmedNamespace}`;
  }

  static splitUniqueServiceName(uniqueServiceName: string): [string, string, string] {
    const [serviceName, namespace, serviceVersion] = uniqueServiceName.split('\t');
    return [serviceName.trim(), namespace.trim(), serviceVersion.trim()];
  }

  static generateUniqueEndpointName(serviceName: string, namespace: string, serviceVersion: string, methodUpperCase: string, path: string) {
    const trimmedServiceName = serviceName.trim();
    const trimmedNamespace = namespace.trim();
    const trimmedServiceVersion = serviceVersion.trim();
    const trimmedMethod = methodUpperCase.trim();
    const trimmedPath = path.trim();

    // The simulator uses a fake host and defaults the port to 80 when generating the UniqueEndpointName.
    const url = `http://${trimmedServiceName}.${trimmedNamespace}.svc.cluster.local${trimmedPath}`;

    return `${trimmedServiceName}\t${trimmedNamespace}\t${trimmedServiceVersion}\t${trimmedMethod}\t${url}`;
  }

  static extractUniqueServiceNameFromEndpointName(uniqueEndpointName: string): string {
    return uniqueEndpointName.split('\t').slice(0, 3).join('\t');
  }

  static getPathFromUrl(url: string) {
    try {
      return new URL(url).pathname;
    } catch {
      return "/";
    }
  }

}
