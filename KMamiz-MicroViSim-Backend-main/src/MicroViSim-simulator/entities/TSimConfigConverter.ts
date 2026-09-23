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

/**
 * One fixed-duration time slot of observed metrics.
 *
 * Slots are contiguous and all the same wall-clock length (`slotDurationSeconds` on
 * EndpointObservedMetrics), so the ARRAY INDEX is a linear time axis — that's what
 * makes the OLS drift regression, the gap-adjacency checks and the spike run-length
 * scan meaningful. Do not compact or reorder the array.
 *
 * The slot duration is derived from the CSV's own sampling interval, NOT fixed at one
 * hour. A 15-minute load test produces ~15 one-minute slots, not 1 real hour plus 23
 * synthetic ones.
 */
export interface TimeSlotStats {
    /** Position in the slot array; also the time axis (slot i starts at i × slotDurationSeconds). */
    slotIndex: number;
    rps: number;
    p50Ms: number;
    p95Ms: number;
    errorRate: number;
    replicaCount: number;

    /**
     * True when no CSV row fell in this slot, so p50Ms/p95Ms/replicaCount are carried
     * forward from the previous real slot and rps/errorRate are 0.
     *
     * Carry-forward keeps the index→time mapping linear for the adjacency/regression
     * logic, but these values are NOT observations. Statistics that summarise observed
     * behaviour must filter on `!isGap`; only logic that reasons about time or adjacency
     * should walk the full array.
     *
     * Distinct from `rps === 0`: a real slot can legitimately have zero traffic during an
     * idle period, and its p50/p95 are then genuine measurements.
     */
    isGap: boolean;
}

/** Chosen bucketing grid — same slot duration for every endpoint in one CSV. */
export interface SlotGrid {
    slotDurationSeconds: number;
    /** Median gap between consecutive distinct timestamps in the source data. */
    nativeIntervalSeconds: number;
    observedSpanSeconds: number;
    /** Human-readable explanation of how slotDurationSeconds was picked; surfaced in diagnostics. */
    reason: string;
}

/** Derived summary for a single endpoint, used by ParameterDeriver */
export interface EndpointObservedMetrics {
    service: string;
    endpoint: string;
    slotStats: TimeSlotStats[];

    /** Wall-clock length of one slot. Converts per-slot quantities to per-hour: 3600 / this. */
    slotDurationSeconds: number;
    /** Median gap between consecutive distinct timestamps in the source CSV. */
    nativeIntervalSeconds: number;
    /** How slotDurationSeconds was chosen (native / coarsened / capped / explicit). */
    slotGridReason: string;
    /** Span actually covered by this endpoint's own rows (first → last timestamp). */
    observedSpanSeconds: number;

    baselineP50Ms: number;      // median p50 during low-load, non-gap slots
    baselineP95Ms: number;      // median p95 during low-load, non-gap slots
    baselineJitterMs: number;   // baselineP95 - baselineP50
    peakRps: number;
    replicaCountAtPeak: number;
    medianErrorRate: number;    // median over non-gap slots only

    /**
     * OLS slope of p50 over the slot index — i.e. ms per SLOT, not per hour.
     * ParameterDeriver converts it to ms/hour before comparing against any threshold;
     * see the comment on DerivationDiagnostics.rawDriftSlopeMsPerHour.
     */
    driftSlopeMsPerSlot: number;
}

/** Slots per hour implied by a slot duration. The single conversion factor between
 *  calibration units (per-slot) and the target simulator's units (per-hour). */
export function slotsPerHourFor(slotDurationSeconds: number): number {
    return 3600 / Math.max(1, slotDurationSeconds);
}

// ─── Layer 2：ParameterDeriver ────────────────────────────────────────────────

export interface DerivationDiagnostics {
    /**
     * Drift slope normalised to ms/HOUR (= driftSlopeMsPerSlot × slotsPerHour).
     *
     * This is the ONLY value ever compared against driftDetectionThresholdMs, which is
     * documented in ms/hour. Comparing the raw per-slot slope instead would make drift
     * detection depend on the CSV's sampling rate: a genuine 120 ms/hour drift is a
     * 2 ms/slot slope at 1-minute resolution, which would sit right on the default 2.0
     * threshold instead of 60× above it.
     */
    rawDriftSlopeMsPerHour: number;

    /** Whether the drift pattern looks monotonic (true) or sawtooth/intermittent (false) */
    isDriftMonotonic: boolean;

    /** Coefficient of variation of RPS — high CV means bursty traffic */
    rpsCoeffOfVariation: number;

    /** Confidence in drift detection: "none" | "weak" | "strong" */
    driftConfidence: "none" | "weak" | "strong";

    /** The low-load slot threshold used for baseline computation (% of peak RPS) */
    lowLoadThresholdPct: number;

    /** True when the endpoint had too few slots to infer patterns; see MIN_SLOTS_FOR_STATS. */
    insufficientSlots: boolean;
}

/**
 * Derived YAML parameters for a single endpoint's delay config.
 *
 * NOTE the units: driftRatePerSlot is in CALIBRATION units (ms per calibration slot),
 * because LatencySimulator.advanceDrift is called once per slot and the calibration runs
 * at the CSV's own resolution. ConverterService converts to per-hour at emit time, since
 * the real simulator's slot is one hour.
 */
export interface DerivedEndpointParams {
    service: string;
    endpoint: string;
    latencyMs: number;
    jitterMs: number;
    errorRate: number;    // 0–1, maps to errorRatePercentage after ×100
    capacityPerReplica: number;   // req/second — duration-independent

    hasDrift: boolean;
    driftRatePerSlot: number;
    driftMode: "time" | "request" | "request-with-recovery";

    diagnostics: DerivationDiagnostics;   // Diagnostics (not written to YAML, used by Layer 3 and for reporting)
}

export interface ParameterDeriverOptions {
    /**
     * Fan-out correction factor per service.
     * If k6 CSV RPS includes internal fan-out calls, divide by this factor
     * before deriving capacityPerReplica.
     * Key: service name, Value: fan-out multiplier (≥1).
     */
    fanOutFactors?: Record<string, number>;

    /**
     * Minimum drift slope (ms/hour) to be considered a real drift, not noise.
     * Compared against rawDriftSlopeMsPerHour, never against the per-slot slope.
     * Default: 2.0
     */
    driftDetectionThresholdMs?: number;

    /**
     * Low-load threshold as a fraction of peak RPS.
     * Slots with RPS below (peak × threshold) are used for baseline.
     * Default: 0.5
     */
    lowLoadThresholdPct?: number;
}

// ─── Layer 3：ConverterService ──────────────────────────────────────────────

export type DelayType = "jitter" | "spike" | "gradualDrift" | "loadDriven";

export interface MapeScores {
    latency: number;     // MAPE on p50, median across sampleCount simulation runs
    errorRate: number;   // MAPE on error rate (pooled across slots), median across runs
    rps: number;         // MAPE on RPS, median across runs — structurally 0, see note below
    weighted: number;    // 0.5 * latency + 0.3 * errorRate + 0.2 * rps, computed from the medians above

    /**
     * Std dev of `weighted` across the repeated simulation runs, measured around this
     * median-based `weighted` value (not the arithmetic mean). The underlying simulator
     * is stochastic (Math.random()-driven latency/error sampling), so a single run's
     * MAPE is noisy — this indicates how much the reported `weighted` score could have
     * varied by chance for the winning candidate.
     */
    weightedStdDev: number;

    /** How many simulation runs were aggregated to produce this score. */
    sampleCount: number;

    /**
     * How many time slots were actually comparable (see ConverterService's MAPE mask).
     * A MAPE computed over 2 slots means something very different from one over 90.
     */
    comparedSlotCount: number;
}

/** How the observed data was bucketed, and what had to be extrapolated to emit it. */
export interface SlotModel {
    slotDurationSeconds: number;
    nativeIntervalSeconds: number;
    slotCount: number;
    observedSpanSeconds: number;
    /** Why this slot duration was chosen. */
    reason: string;
    /**
     * Extrapolation warnings — e.g. drift measured over a sub-hour span but emitted as a
     * per-hour rate that the simulator will replay over 24–168 hourly slots.
     */
    notes: string[];
}

/** Converted config for one endpoint, ready to patch into YAML */
export interface ConvertedEndpointConfig {
    service: string;
    endpoint: string;
    /** Delay config in the TARGET simulator's units (per-hour), not calibration units. */
    delays: TSimulationEndpointDelay[];
    capacityPerReplica: number;
    errorRatePercentage: number;      // errorRate × 100 (YAML field convention)

    /** MAPE scores of the winning candidate */
    mape: MapeScores;

    /** Which delay types were selected and why */
    selectedTypes: DelayType[];
    selectionReasons: Partial<Record<DelayType, string>>;

    /** Bucketing model and extrapolation notes for this endpoint. */
    slotModel: SlotModel;
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
