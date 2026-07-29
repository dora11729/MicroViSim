import YAML from "yaml";
import { ConverterResult } from "../entities/TConverter";

function cleanDelay(delay: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(delay)) {
    if (value !== undefined && value !== null) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

export function buildLoadSimulationSection(
  result: ConverterResult,
  namespace = "default",
  version = "v1",
) {
  const serviceCapacity = new Map<string, number>();
  for (const ep of Object.values(result.convertedEndpoints)) {
    const current = serviceCapacity.get(ep.service) ?? 0;
    serviceCapacity.set(ep.service, Math.max(current, ep.capacityPerReplica));
  }

  const endpointMetrics = Object.values(result.convertedEndpoints).map((ep) => ({
    endpointId: ep.endpoint,
    delay: ep.delays.map((d) => cleanDelay(d as Record<string, unknown>)),
    errorRatePercent: ep.errorRatePercent,
  }));

  return {
    config: {
      simulationDurationInDays: 1,
    },
    serviceMetrics: [
      {
        namespace,
        services: Array.from(serviceCapacity.entries()).map(([serviceName, capacityPerReplica]) => ({
          serviceName,
          versions: [{ version, capacityPerReplica }],
        })),
      },
    ],
    endpointMetrics,
  };
}

export function buildLoadSimulationYaml(
  result: ConverterResult,
  namespace = "default",
  version = "v1",
): string {
  return YAML.stringify({
    loadSimulation: buildLoadSimulationSection(result, namespace, version),
  });
}

export function mergeLoadSimulationIntoYaml(
  existingYaml: string,
  result: ConverterResult,
  namespace = "default",
  version = "v1",
): string {
  let doc: Record<string, unknown> = {};
  if (existingYaml.trim()) {
    doc = (YAML.parse(existingYaml) as Record<string, unknown>) ?? {};
  }
  doc.loadSimulation = buildLoadSimulationSection(result, namespace, version);
  return YAML.stringify(doc);
}

export function downloadTextFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
