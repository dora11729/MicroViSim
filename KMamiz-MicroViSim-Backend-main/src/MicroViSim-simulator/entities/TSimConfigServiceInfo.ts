import { requestType } from "../../entities/TRequestType";
import { z } from "zod";
import {
  endpointIdSchema,
  systemGeneratedFieldsSuperRefine,
  versionSchema
} from "./TSimConfigGlobal";


/**** Simulation configuration YAML format validation ****/
/** servicesInfo **/

// Endpoint
const statusCodeSchema = z.union([
  z.number().int().refine((val) => val >= 100 && val <= 599, {
    message: "Invalid status. It must be between 100 and 599.",
  }),
  z.string().refine((val) => {
    const num = Number(val);
    return Number.isInteger(num) && num >= 100 && num <= 599;
  }, {
    message: "Invalid status. It must be an integer string between 100 and 599.",
  }),
]).transform((val) => String(val));

export const simulationResponseBodySchema = z.object({
  status: statusCodeSchema,
  responseContentType: z.string(),
  responseBody: z.string(),
}).strict();

export const simulationEndpointDatatypeSchema = z.object({
  requestContentType: z.string(),
  requestBody: z.string(),
  responses: z.array(simulationResponseBodySchema),
}).strict();

export const simulationEndpointInfoSchema = z.object({
  path: z.string().min(1, { message: "path cannot not be empty." }),
  method: z.enum(requestType),
}).strict();

export const simulationEndpointSchema = z.object({
  uniqueEndpointName: z.string().optional(),// Users do not need to provide this.
  endpointId: endpointIdSchema,
  endpointInfo: simulationEndpointInfoSchema,
  datatype: simulationEndpointDatatypeSchema.optional(),
}).strict()
  .superRefine(systemGeneratedFieldsSuperRefine());



// Service 
export const simulationServiceVersionSchema = z.object({
  uniqueServiceName: z.string().optional(),// Users do not need to provide this.
  version: versionSchema,
  replica: z.number()
    .int({ message: "replica must be an integer." })
    .min(0, { message: "replica (the number of service instances) must be at least 0 to simulate injection." })
    .default(1),
  endpoints: z.array(simulationEndpointSchema),
}).strict()
  .superRefine(systemGeneratedFieldsSuperRefine());

export const simulationServiceSchema = z.object({
  serviceName: z.string().min(1, { message: "service name cannot be empty." }),
  versions: z.array(simulationServiceVersionSchema),
}).strict();




// Services info main schema
export const simulationNamespaceSchema = z.object({
  namespace: z.string(),
  services: z.array(simulationServiceSchema),
}).strict();



/**** Schema to type ****/
export type TSimulationResponseBody = z.infer<typeof simulationResponseBodySchema>;
export type TSimulationEndpointDatatype = z.infer<typeof simulationEndpointDatatypeSchema>;
export type TSimulationEndpointInfo = z.infer<typeof simulationEndpointInfoSchema>;
export type TSimulationEndpoint = z.infer<typeof simulationEndpointSchema>;
export type TSimulationServiceVersion = z.infer<typeof simulationServiceVersionSchema>;
export type TSimulationService = z.infer<typeof simulationServiceSchema>;
export type TSimulationNamespace = z.infer<typeof simulationNamespaceSchema>;
