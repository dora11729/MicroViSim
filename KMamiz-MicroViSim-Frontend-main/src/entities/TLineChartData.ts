export type TLineChartDataFields =
  | "requests"
  | "requestErrors"
  | "serverErrors"
  | "latencyCV"
  | "latencyMean"
  | "latencyP95"
  | "risk"
  | "replicas"
  | "utilization"
  | "latencyMeanNoDownstream";

export type TLineChartData = {
  dates: number[];
  services: string[];
  metrics: [number, number, number, number, number, number, number, number, number, number][][];
};

const FieldIndex = [
  "requests",
  "requestErrors",
  "serverErrors",
  "latencyCV",
  "latencyMean",
  "latencyP95",
  "risk",
  "replicas",
  "utilization",
  "latencyMeanNoDownstream",
];

export { FieldIndex };
