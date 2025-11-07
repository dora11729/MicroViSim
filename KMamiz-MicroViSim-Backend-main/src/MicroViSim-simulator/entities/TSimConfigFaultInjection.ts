import {
  endpointIdSchema,
  systemGeneratedFieldsSuperRefine,
  versionSchema
} from "./TSimConfigGlobal";
import { z } from "zod";

/**** Simulation configuration YAML format validation ****/
/** load simulation -> fault Injection**/


// basic settings for faults (time and target)
const faultInjectionPeriodSchema = z.object({
  startTime: z.object({
    day: z.number().int().min(1).max(7),
    hour: z.number().int().min(0).max(23),
  }), // Fault injection start time
  durationHours: z.number().int().min(1), //Fault injection duration
  probabilityPercent: z.number().min(0).max(100).default(100), // Probability of fault occurrence during injection period
}).strict();

const faultTimeSchema = z.array(faultInjectionPeriodSchema).min(1);

const faultTargetServiceSchema = z.object({
  uniqueServiceName: z.string().optional(),// Users do not need to provide this.
  serviceName: z.string().min(1, { message: "serviceName cannot be empty." }),
  namespace: z.string().min(1, { message: "namespace cannot be empty." }),
  version: versionSchema.optional(),  // If not specified, applies to all versions of the service
}).strict().superRefine(systemGeneratedFieldsSuperRefine());

const faultTargetEndpointSchema = z.object({
  uniqueEndpointName: z.string().optional(),// Users do not need to provide this.
  endpointId: endpointIdSchema,
}).strict().superRefine(systemGeneratedFieldsSuperRefine());



// All supported fault injection types
const increaseLatencyFaultSchema = z.object({
  type: z.literal("increase-latency"),
  targets: z.object({
    services: z.array(faultTargetServiceSchema).default([]),
    endpoints: z.array(faultTargetEndpointSchema).default([]),
  }).strict(),
  timePeriods: faultTimeSchema,
  increaseLatencyMs: z
    .number()
    .min(0, { message: "increaseLatencyMs must be zero or greater." })
}).strict();

const increaseErrorRateFaultSchema = z.object({
  type: z.literal("increase-error-rate"),
  targets: z.object({
    services: z.array(faultTargetServiceSchema).default([]),
    endpoints: z.array(faultTargetEndpointSchema).default([]),
  }).strict(),
  timePeriods: faultTimeSchema,
  increaseErrorRatePercent: z
    .number()
    .refine((val) => val >= 0 && val <= 100, {
      message: "Invalid increaseErrorRatePercent. It must be between 0 and 100.",
    })
}).strict();

const injectTrafficFaultSchema = z.object({
  type: z.literal("inject-traffic"),
  targets: z.object({
    services: z.array(faultTargetServiceSchema).default([]),
    endpoints: z.array(faultTargetEndpointSchema).default([]),
  }).strict(),
  timePeriods: faultTimeSchema,
  increaseRequestCount: z
    .number()
    .int({ message: "increaseRequestCount must be an integer." })
    .min(1, { message: "increaseRequestCount must be at least 1." })
    .optional(),
  requestMultiplier: z
    .number()
    .refine((val) => val > 0, {
      message: "requestMultiplier must be greater than 0.",
    })
    .optional(),
}).strict();

const reduceInstanceFaultSchema = z.object({
  type: z.literal("reduce-instance"),
  targets: z.object({
    services: z.array(faultTargetServiceSchema).default([]),
  }).strict(),
  timePeriods: faultTimeSchema,
  reduceCount: z.number().int().min(1),
}).strict();


// Fault main schema
export const faultSchema = z.discriminatedUnion("type", [
  increaseLatencyFaultSchema,
  increaseErrorRateFaultSchema,
  reduceInstanceFaultSchema,
  injectTrafficFaultSchema
]);


/**** schema to type ****/
//  Load Simulation config
export type TSimulationFaultTargetEndpoint = z.infer<typeof faultTargetEndpointSchema>;
export type TSimulationFaults = z.infer<typeof faultSchema>;
