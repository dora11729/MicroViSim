export interface MapeScores {
  latency: number;
  errorRate: number;
  rps: number;
  weighted: number;
  weightedStdDev: number;
  sampleCount: number;
  /** How many time slots were actually comparable when scoring. */
  comparedSlotCount: number;
}

/** How the observed data was bucketed, and what had to be extrapolated to emit it. */
export interface SlotModel {
  slotDurationSeconds: number;
  nativeIntervalSeconds: number;
  slotCount: number;
  observedSpanSeconds: number;
  reason: string;
  notes: string[];
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
  errorRatePercentage: number;
  mape: MapeScores;
  selectedTypes: string[];
  selectionReasons: Record<string, string>;
  slotModel: SlotModel;
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
  /** Force a bucket size instead of deriving one from the CSV's sampling interval. */
  slotDurationSeconds?: number;
  fanOutFactors?: Record<string, number>;
  driftDetectionThresholdMs?: number;
  lowLoadThresholdPct?: number;
  searchRangePct?: number;
  searchSteps?: number;
  mapeWeights?: { latency: number; errorRate: number; rps: number };
  spikeRatioThreshold?: number;
  loadCorrelationThreshold?: number;
  mapeSamplesPerCandidate?: number;
}

export interface K6ConverterConfig {
  nameMap: Record<string, { service: string; endpoint: string }>;
  replicaCounts?: Record<string, number>;
}
