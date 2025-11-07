import { z } from "zod";
import { simulationNamespaceSchema } from "./TSimConfigServiceInfo";
import { simulationEndpointDependencySchema } from "./TSimConfigEndpointDependency";
import { loadSimulationSchema } from "./TSimConfigLoadSimulation";

/**** Simulation configuration YAML format validation ****/
/** Top-level schema for validating the full SimConfig YAML **/
export const simulationConfigYAMLSchema = z.object({
  servicesInfo: z.array(simulationNamespaceSchema),
  endpointDependencies: z.array(simulationEndpointDependencySchema),
  loadSimulation: loadSimulationSchema.optional(),
}).strict();


/**** schema to type ****/
export type TSimulationConfigYAML = z.infer<typeof simulationConfigYAMLSchema>;




