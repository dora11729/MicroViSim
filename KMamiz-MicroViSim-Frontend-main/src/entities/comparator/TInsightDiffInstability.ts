type TInsightInstabilityPerVersion = {
  versionTag: string;
  dependingBy: number;
  dependingOn: number;
  instability: number;
};

export type TInsightDiffInstability = {
  uniqueServiceName: string;
  name: string;
  instabilitiesByVersion: TInsightInstabilityPerVersion[];
};
