import { TGraphData } from "../TGraphData";
import { TTotalServiceInterfaceCohesion } from "../TTotalServiceInterfaceCohesion";
import { TServiceCoupling } from "../TServiceCoupling";
import { TServiceInstability } from "../TServiceInstability";
import TEndpointDataType from "../TEndpointDataType";

export type TTaggedDiffData = {
  _id?: string;
  tag: string;
  time?: number;
  graphData:TGraphData;
  cohesionData:TTotalServiceInterfaceCohesion[];
  couplingData:TServiceCoupling[];
  instabilityData:TServiceInstability[];
  endpointDataTypesMap: Record<string, TEndpointDataType>;
};

export type TagWithTime = {
  tag: string;
  time: number;
}
