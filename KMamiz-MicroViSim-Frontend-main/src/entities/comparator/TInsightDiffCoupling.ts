type TInsightCouplingPerVersion = {
  versionTag: string;
  ais: number;
  ads: number;
  acs: number;
};

export type TInsightDiffCoupling = {
  uniqueServiceName: string;
  name: string;
  couplingsByVersion: TInsightCouplingPerVersion[];
};

