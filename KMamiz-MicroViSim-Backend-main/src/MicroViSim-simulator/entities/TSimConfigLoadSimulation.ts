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
  overloadLatencyIncreaseFactor: z
    .number()
    .refine((val) => val >= 0 && val <= 10, {
      message: "Invalid overloadLatencyIncreaseFactor. It must be between 0 and 10.",
    })
    .default(5),
  overloadLatencyAmplifier: z
    .number()
    .refine((val) => val >= 0, {
      message: "Invalid overloadLatencyAmplifier. It must be at least 1",
    })
    .default(10),
  // TODO: May expand with additional config options such as chaosMonkeyEnabled, errorRateAmplificationFactor, etc^_^.
}).strict().default({
  simulationDurationInDays: 1,
  overloadErrorRateIncreaseFactor: 3,
  overloadLatencyIncreaseFactor: 5,
  overloadLatencyAmplifier: 10,
});


// Service metric
const autoScalingModels = [
  "xgboost", 
  "random_forest", 
  "lstm"
] as const;

export const simulationServiceVersionScalingSchema = z.object({
  model: z.enum(autoScalingModels, { message: "model must be one of 'xgboost', 'random_forest', or 'lstm'." })
    .optional(),
  targetUtilization: z.number()
    .min(0.01, {message: "targetUtilization must be at least 0.01."})
    .max(1, { message: "targetUtilization cannot exceed 1." }).default(0.7),
  tolerance: z.number()
    .min(0.01, {message: "tolerance must be at least 0.01."})
    .max(1, { message: "tolerance cannot exceed 1." }).default(0.25),
  maxScaleStep: z.number().min(1, {message: "maxScaleStep must be at least 1."}).default(2),
  maxReplicas: z.number().min(1, {message: "maxReplicas must be at least 1."}).default(10),
}).strict();

export const simulationServiceVersionMetricSchema = z.object({
  uniqueServiceName: z.string().optional(),// Users do not need to provide this.
  version: versionSchema,
  capacityPerReplica: z.number()
    .min(0.01, { message: "capacityPerReplica must be at least 0.01." })
    .default(1),
  autoScaling: simulationServiceVersionScalingSchema.optional(),
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

// -------- latency --------
const baseDelaySchema = z.object({
  latencyMs: z.number().min(0, {
    message: "latencyMs must be zero or greater.",
  }).default(0),
  jitterMs: z.number().min(0, {
    message: "jitterMs must be zero or greater.",
  }).default(0),
});

const stableDelaySchema = baseDelaySchema.extend({
  type: z.literal("stable", {
    message: "type must be stable, spike, jitter, gradualDrift or loadDriven.",
  }),
});

const jitterDelaySchema = baseDelaySchema.extend({
  type: z.literal("jitter", {
    message: "type must be stable, spike, jitter, gradualDrift or loadDriven.",
  }),
});

const spikeDelaySchema = baseDelaySchema.extend({
  type: z.literal("spike", {
    message: "type must be stable, spike, jitter, gradualDrift or loadDriven.",
  }),
  spikeProbability: z.number()
    .refine((val) => val >= 0 && val <= 1, {
      message: "Invalid spikeProbability. It must be between 0 and 1.",
    })
    .default(0.05),
  spikeMagnitude: z.number().min(1, {
    message: "spikeMagnitude must be at least 1.",
  }).default(5),
  spikeDuration: z.number()
    .int({ message: "spikeDuration must be an integer." })
    .min(1, { message: "spikeDuration must be at least 1." })
    .default(1),
});

const gradualDriftDelaySchema = baseDelaySchema.extend({
  type: z.literal("gradualDrift", {
    message: "type must be stable, spike, jitter, gradualDrift or loadDriven.",
  }),
  driftRate: z.number().min(0, {
    message: "driftRate must be zero or greater.",
  }).default(4)
});

const loadDrivenDelaySchema = baseDelaySchema.extend({
  type: z.literal("loadDriven", {
    message: "type must be stable, spike, jitter, gradualDrift or loadDriven.",
  }),
});

const singleDelaySchema = z.discriminatedUnion("type", [
  stableDelaySchema,
  jitterDelaySchema,
  spikeDelaySchema,
  gradualDriftDelaySchema,
  loadDrivenDelaySchema,
]).default({ type: "stable" });

const endpointDelaySchema = z.array(singleDelaySchema)
  .min(1, { message: "delay must have at least one entry." })
  .default([{ type: "stable" }]);



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
  maxLatencyMs: z.number().min(0, {
    message: "maxLatencyMs must be zero or greater.",
  }).default(0),
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
export type TSimulationServiceVersionScalingSchema = z.infer<typeof simulationServiceVersionScalingSchema>;
export type TSimulationServiceVersionMetric = z.infer<typeof simulationServiceVersionMetricSchema>;
export type TSimulationServiceMetric = z.infer<typeof simulationServiceMetricSchema>;
export type TSimulationNamespaceServiceMetrics = z.infer<typeof simulationNamespaceServiceMetricsSchema>;
export type TSimulationEndpointDelay = z.infer<typeof singleDelaySchema>;
export type TSimulationEndpointMetric = z.infer<typeof simulationEndpointMetricSchema>;
export type TLoadSimulationSettings = z.infer<typeof loadSimulationSchema>;
