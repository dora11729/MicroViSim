export type TLineChartDataFields =
  | "requests"
  | "requestErrors"
  | "serverErrors"
  | "latencyCV"
  | "latencyMean"
  | "risk"
  | "replicas";

export type TLineChartData = {
  dates: number[];
  services: string[];
  metrics: [number, number, number, number, number, number, number][][];
};

const FieldIndex = [
  "requests",
  "requestErrors",
  "serverErrors",
  "latencyCV",
  "latencyMean",
  "risk",
  "replicas",
];

export { FieldIndex };
