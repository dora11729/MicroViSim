import { Types } from "mongoose";

export type TTaggedSimulationYAML = {
  _id?: Types.ObjectId;
  tag?: string;
  time?: number;
  yaml: string;
};