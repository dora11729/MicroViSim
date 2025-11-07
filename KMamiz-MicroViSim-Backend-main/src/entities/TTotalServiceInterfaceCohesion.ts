import { TEndpointCohesion } from "./TServiceCohesion";
import { TServiceEndpointsConsumer } from "./TServiceEndpointCohesion";

export type TTotalServiceInterfaceCohesion = {
  uniqueServiceName: string;
  isDatatypeMatched: boolean;
  name: string;
  dataCohesion: number; // SIDC
  usageCohesion: number; // SIUC
  totalInterfaceCohesion: number; // TSIC
  endpointCohesion: TEndpointCohesion[];
  totalEndpoints: number;
  consumers: TServiceEndpointsConsumer[];
};
