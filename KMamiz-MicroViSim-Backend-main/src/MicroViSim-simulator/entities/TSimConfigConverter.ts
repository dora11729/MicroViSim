// ─── Layer 1：MetricsExtractor ────────────────────────────────────────────────

import { TSimulationEndpointDelay } from "./TSimConfigLoadSimulation";

export interface RawMetricRow {
    timestamp: Date;
    service: string;
    endpoint: string;
    rps: number;
    p50Ms: number;
    p95Ms: number;
    errorRate: number;        // 0–1
    replicaCount: number;
}

export interface HourlyStats {
    hour: number;             // 0–23
    rps: number;
    p50Ms: number;
    p95Ms: number;
    errorRate: number;
    replicaCount: number;
}

/** Derived summary for a single endpoint, used by ParameterDeriver */
export interface EndpointObservedMetrics {
    service: string;
    endpoint: string;
    hourlyStats: HourlyStats[];
    baselineP50Ms: number;      // median p50 during low-load hours
    baselineP95Ms: number;      // median p95 during low-load hours
    baselineJitterMs: number;   // baselineP95 - baselineP50
    peakRps: number;
    replicaCountAtPeak: number;
    medianErrorRate: number;
    driftSlopeMs: number;     // linear regression slope of p50 over time (ms per hour)
}

// ─── Layer 2：ParameterDeriver ────────────────────────────────────────────────

export interface DerivationDiagnostics {
    /** Raw slope from linear regression (ms/hour), before slot conversion */
    rawDriftSlopeMsPerHour: number;

    /** Whether the drift pattern looks monotonic (true) or sawtooth/intermittent (false) */
    isDriftMonotonic: boolean;

    /** Coefficient of variation of RPS — high CV means bursty traffic */
    rpsCoeffOfVariation: number;

    /** Confidence in drift detection: "none" | "weak" | "strong" */
    driftConfidence: "none" | "weak" | "strong";

    /** The low-load hour threshold used for baseline computation (% of peak RPS) */
    lowLoadThresholdPct: number;
}

/**
 * Derived YAML parameters for a single endpoint's delay config.
 * Maps 1-to-1 to fields in TSimConfigLoadSimulation gradualDrift / stable schema.
 */
export interface DerivedEndpointParams {
    service: string;
    endpoint: string;
    latencyMs: number;
    jitterMs: number;
    errorRate: number;    // 0–1, maps to errorRatePercent after ×100
    capacityPerReplica: number;

    hasDrift: boolean;
    driftRate: number;
    driftMode: "time" | "request" | "request-with-recovery";

    diagnostics: DerivationDiagnostics;   // Diagnostics (not written to YAML, used by Layer 3 and for reporting)
}

export interface ParameterDeriverOptions {
    /**
     * How many MicroViSim time slots fit in one hour.
     * Default: 1 (hourly slots). Use 60 if slots are per-minute.
     */
    slotsPerHour?: number;

    /**
     * Fan-out correction factor per service.
     * If k6 CSV RPS includes internal fan-out calls, divide by this factor
     * before deriving capacityPerReplica.
     * Key: service name, Value: fan-out multiplier (≥1).
     */
    fanOutFactors?: Record<string, number>;

    /**
     * Minimum drift slope (ms/hour) to be considered a real drift, not noise.
     * Default: 2.0
     */
    driftDetectionThresholdMs?: number;

    /**
     * Low-load threshold as a fraction of peak RPS.
     * Hours with RPS below (peak × threshold) are used for baseline.
     * Default: 0.5
     */
    lowLoadThresholdPct?: number;
}

// ─── Layer 3：ConverterService ──────────────────────────────────────────────

export type DelayType = "stable" | "jitter" | "spike" | "gradualDrift" | "loadDriven";

export interface MapeScores {
    latency: number;     // MAPE on p50
    errorRate: number;   // MAPE on error rate
    rps: number;         // MAPE on RPS (via capacityPerReplica check)
    weighted: number;    // 0.5 * latency + 0.3 * errorRate + 0.2 * rps
}

/** Converted config for one endpoint, ready to patch into YAML */
export interface ConvertedEndpointConfig {
    service: string;
        endpoint: string;
        delays: TSimulationEndpointDelay[];
        capacityPerReplica: number;
        errorRatePercent: number;      // errorRate × 100 (YAML field convention)
    
        /** MAPE scores of the winning candidate */
        mape: MapeScores;
    
        /** Which delay types were selected and why */
        selectedTypes: DelayType[];
        selectionReasons: Partial<Record<DelayType, string>>;
    }

export interface ConverterResult {
    convertedEndpoints: Map<string, ConvertedEndpointConfig>;

    /** Summary stats across all endpoints */
    summary: {
        meanWeightedMape: number;
        endpointCount: number;
        delayTypeDistribution: Record<DelayType, number>;
    };
}