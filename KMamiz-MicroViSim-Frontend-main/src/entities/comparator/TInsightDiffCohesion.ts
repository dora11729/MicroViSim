type TInsightCohesionPerVersion = {
  versionTag: string; 
  dataCohesion: number; // SIDC
  usageCohesion: number; // SIUC
  totalInterfaceCohesion: number; // TSIC
}

export type TInsightDiffCohesion = {
  uniqueServiceName: string;
  name: string;
  cohesionsByVersion:TInsightCohesionPerVersion[]
};

