export interface MapeScores {
  latency: number;
  errorRate: number;
  rps: number;
  weighted: number;
}

export interface ConvertedEndpoint {
  service: string;
  endpoint: string;
  delays: Array<{
    type: string;
    latencyMs: number;
    jitterMs: number;
    driftRate?: number;
    driftMode?: string;
    recoveryRate?: number;
    spikeProbability?: number;
    spikeMagnitude?: number;
    spikeDuration?: number;
    [key: string]: unknown;
  }>;
  capacityPerReplica: number;
  errorRatePercent: number;
  mape: MapeScores;
  selectedTypes: string[];
  selectionReasons: Record<string, string>;
}

export interface ConverterResult {
  summary: {
    meanWeightedMape: number;
    endpointCount: number;
    delayTypeDistribution: Record<string, number>;
  };
  convertedEndpoints: Record<string, ConvertedEndpoint>;
}

export interface ConverterRunOptions {
  slotsPerHour?: number;
  fanOutFactors?: Record<string, number>;
  driftDetectionThresholdMs?: number;
  lowLoadThresholdPct?: number;
  searchRangePct?: number;
  searchSteps?: number;
  mapeWeights?: { latency: number; errorRate: number; rps: number };
  spikeRatioThreshold?: number;
  loadCorrelationThreshold?: number;
  jitterCvThreshold?: number;
}

export interface K6ConverterConfig {
  nameMap: Record<string, { service: string; endpoint: string }>;
  replicaCounts?: Record<string, number>;
}
