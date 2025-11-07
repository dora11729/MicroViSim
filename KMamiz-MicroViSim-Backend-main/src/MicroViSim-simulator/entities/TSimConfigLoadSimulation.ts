import {
  endpointIdSchema,
  systemGeneratedFieldsSuperRefine,
  versionSchema
} from "./TSimConfigGlobal";
import {
  faultSchema,

} from "./TSimConfigFaultInjection";
import { z } from "zod";


/**** Simulation configuration YAML format validation ****/
/** Load simulation **/

// Load simulation basic config
export const loadSimulationConfigSchema = z.object({
  simulationDurationInDays: z.number()
    .int({ message: "simulationDurationInDays must be an integer." })
    .min(1, { message: "simulationDurationInDays must be at least 1." })
    .max(7, { message: "simulationDurationInDays cannot exceed 7." })
    .default(1),
  overloadErrorRateIncreaseFactor: z
    .number()
    .refine((val) => val >= 0 && val <= 10, {
      message: "Invalid overloadErrorRateIncreaseFactor. It must be between 0 and 10.",
    })
    .default(3),
  // TODO: May expand with additional config options such as chaosMonkeyEnabled, errorRateAmplificationFactor, etc^_^.
}).strict().default({
  simulationDurationInDays: 1,
  overloadErrorRateIncreaseFactor: 3,
});


// Service metric
export const simulationServiceVersionMetricSchema = z.object({
  uniqueServiceName: z.string().optional(),// Users do not need to provide this.
  version: versionSchema,
  capacityPerReplica: z.number()
    .min(0.01, { message: "capacityPerReplica must be at least 0.01." })
    .default(1),
}).strict()
  .superRefine(systemGeneratedFieldsSuperRefine());

export const simulationServiceMetricSchema = z.object({
  serviceName: z.string().min(1, { message: "serviceName cannot be empty." }),
  versions: z.array(simulationServiceVersionMetricSchema),
}).strict();

export const simulationNamespaceServiceMetricsSchema = z.object({
  namespace: z.string(),
  services: z.array(simulationServiceMetricSchema),
}).strict();

const endpointDelaySchema = z.object({
  latencyMs: z.number().min(0, { message: "latencyMs must be zero or greater." }).default(0),
  jitterMs: z.number().min(0, { message: "jitterMs must be zero or greater." }).default(0),
}).strict().default({
  latencyMs: 0,
  jitterMs: 0,
});



// Endpoint metric
const fallbackStrategies = [
  "failIfAnyDependentFail",
  "failIfAllDependentFail",
  "ignoreDependentFail",
] as const;


export const simulationEndpointMetricSchema = z.object({
  uniqueEndpointName: z.string().optional(),// Users do not need to provide this.
  endpointId: endpointIdSchema,
  delay: endpointDelaySchema,
  errorRatePercent: z
    .number()
    .refine((val) => val >= 0 && val <= 100, {
      message: "Invalid errorRate. It must be between 0 and 100.",
    })
    .default(0),
  expectedExternalDailyRequestCount: z
    .number()
    .int({ message: "expectedExternalDailyRequestCount must be an integer." })
    .min(0, { message: "expectedExternalDailyRequestCount cannot be negative." })
    .default(0),
  fallbackStrategy: z.enum(fallbackStrategies).default(fallbackStrategies[0]),
}).strict().superRefine(systemGeneratedFieldsSuperRefine());



// Load simulation main schema
export const loadSimulationSchema = z.object({
  config: loadSimulationConfigSchema,
  serviceMetrics: z.array(simulationNamespaceServiceMetricsSchema),
  endpointMetrics: z.array(simulationEndpointMetricSchema),
  faultInjection: z.array(faultSchema).optional(),
}).strict();


/**** Schema to type ****/
export type TFallbackStrategy = typeof fallbackStrategies[number];
export type TLoadSimulationConfig = z.infer<typeof loadSimulationConfigSchema>;
export type TSimulationServiceVersionMetric = z.infer<typeof simulationServiceVersionMetricSchema>;
export type TSimulationServiceMetric = z.infer<typeof simulationServiceMetricSchema>;
export type TSimulationNamespaceServiceMetrics = z.infer<typeof simulationNamespaceServiceMetricsSchema>;
export type TSimulationEndpointDelay = z.infer<typeof endpointDelaySchema>;
export type TSimulationEndpointMetric = z.infer<typeof simulationEndpointMetricSchema>;
export type TLoadSimulationSettings = z.infer<typeof loadSimulationSchema>;
