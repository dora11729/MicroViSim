import {
  endpointIdSchema,
  systemGeneratedFieldsSuperRefine,
} from "./TSimConfigGlobal";
import { z } from "zod";

/**** Simulation configuration YAML format validation ****/
/** endpoint dependency **/
const dependOnBaseSchema = z.object({
  uniqueEndpointName: z.string().optional(),
  endpointId: endpointIdSchema,
}).strict();

const normalDependOnSchema = dependOnBaseSchema.extend({
  callProbability: z.number()
    .refine((val) => val >= 0 && val <= 100, { message: "Invalid callProbability. It must be between 0 and 100." })
    .optional(),
});

const OneofGroupDependOnSchema = dependOnBaseSchema.extend({
  callProbability: z.number()
    .refine((val) => val >= 0 && val <= 100, { message: "Invalid callProbability. It must be between 0 and 100." }),
});

const selectOneOfGroupDependOnSchema = z.object({
  oneOf: z.array(OneofGroupDependOnSchema),
}).strict();

const dependOnSchema = z.union([normalDependOnSchema, selectOneOfGroupDependOnSchema]);


// Endpoint dependency main schema
export const simulationEndpointDependencySchema = z.object({
  uniqueEndpointName: z.string().optional(),// Users do not need to provide this.
  isExternal: z.boolean().default(false), // Whether the endpoint is allowed to be called externally
  endpointId: endpointIdSchema,
  dependOn: z.array(dependOnSchema),
}).strict()
  .superRefine(systemGeneratedFieldsSuperRefine());


/**** schema to type ****/
export type TSimulationNormalDependOn = z.infer<typeof normalDependOnSchema>;
export type TSimulationSelectOneOfGroupDependOn = z.infer<typeof selectOneOfGroupDependOnSchema>;
export function isSelectOneOfGroupDependOnType(obj: TSimulationNormalDependOn | TSimulationSelectOneOfGroupDependOn):
  obj is TSimulationSelectOneOfGroupDependOn {
  return selectOneOfGroupDependOnSchema.safeParse(obj).success;
}
export type TSimulationDependOn = z.infer<typeof dependOnSchema>;
export type TSimulationEndpointDependency = z.infer<typeof simulationEndpointDependencySchema>;