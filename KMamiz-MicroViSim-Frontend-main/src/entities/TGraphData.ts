export type TGraphData = {
  nodes: TNode[];
  links: TLink[];
};

export type TNode = {
  // unique id, for linking
  id: string;
  // display name
  name: string;
  // group as a service
  group: string;
  // id list for all dependencies
  dependencies: string[];
  linkInBetween: TLink[];

  /*usage status of the service or endpoint, based on the timestamp of the last usage and the threshold set by the KMamiz user .
    1. "Active" - The service (or endpoint) has been recently used.
    2. "Inactive" - The service (or endpoint) has not been used for a long time, and is considered inactive.
    3. If the service (or endpoint) is no longer for use, it will be removed from the graphData.*/
  usageStatus: "Active" | "Inactive";
};
export type TLink = {
  // link from id
  source: string;
  // link to id
  target: string;
};
