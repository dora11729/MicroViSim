/**
 * Layer 2 of the Auto-Converter pipeline.
 *
 * Takes the observed metrics produced by MetricsExtractor and directly
 * derives MicroViSim YAML parameters using closed-form formulas.
 * No simulation runs are needed at this stage — all derivations are
 * deterministic and based on statistical summaries of real load-test data.
 *
 * Output feeds into:
 *   - Layer 3 (ConverterService) for MAPE-guided fine-tuning
 *   - Direct YAML patch when fine-tuning is skipped
 *
 * Derivation logic per parameter:
 *   latencyMs          ← baselineP50Ms  (median p50 during low-load, non-gap slots)
 *   jitterMs           ← baselineJitterMs (baselineP95 - baselineP50)
 *   errorRate          ← medianErrorRate
 *   capacityPerReplica ← peakRps / replicaCountAtPeak  (corrected for fan-out)
 *   driftRatePerSlot   ← driftSlopeMsPerSlot            (ms per CALIBRATION slot)
 *   driftMode          ← inferred from drift pattern (monotonic vs sawtooth)
 *
 * UNITS: everything this layer emits that is time-dependent is in CALIBRATION slot
 * units, because the calibration simulation runs at the CSV's own resolution and
 * LatencySimulator.advanceDrift is called once per slot. ConverterService converts to
 * the target simulator's per-hour units at emit time.
 */

import {
  EndpointObservedMetrics,
  TimeSlotStats,
  DerivedEndpointParams,
  DerivationDiagnostics,
  ParameterDeriverOptions,
  slotsPerHourFor,
} from "../../entities/TSimConfigConverter";
import { MetricsExtractor } from "./MetricsExtractor";

export class ParameterDeriver {
  private readonly fanOutFactors: Record<string, number>;
  private readonly driftThreshold: number;
  private readonly lowLoadThresholdPct: number;

  constructor(options: ParameterDeriverOptions = {}) {
    this.fanOutFactors      = options.fanOutFactors ?? {};
    this.driftThreshold     = options.driftDetectionThresholdMs ?? 2.0;
    this.lowLoadThresholdPct = options.lowLoadThresholdPct ?? 0.5;
  }

  /**
   * Main entry point.
   * @param metricsMap - Output of MetricsExtractor.extract()
   * @returns Map keyed by "service::endpoint", same key format as MetricsExtractor
   */
  derive(
    metricsMap: Map<string, EndpointObservedMetrics>
  ): Map<string, DerivedEndpointParams> {
    const result = new Map<string, DerivedEndpointParams>();

    for (const [key, metrics] of metricsMap.entries()) {
      result.set(key, this.deriveOne(metrics));
    }

    return result;
  }

  // ─── Per-endpoint derivation ───────────────────────────────────────────────

  private deriveOne(m: EndpointObservedMetrics): DerivedEndpointParams {
    const latencyMs  = this.deriveLatencyMs(m);
    const jitterMs   = this.deriveJitterMs(m);
    const errorRate  = this.deriveErrorRate(m);
    const capacityPerReplica = this.deriveCapacityPerReplica(m);

    const {
      hasDrift,
      driftRatePerSlot,
      driftMode,
      diagnostics,
    } = this.deriveDrift(m);

    return {
      service:  m.service,
      endpoint: m.endpoint,
      latencyMs,
      jitterMs,
      errorRate,
      capacityPerReplica,
      hasDrift,
      driftRatePerSlot,
      driftMode,
      diagnostics,
    };
  }

  // ─── Individual parameter derivations ─────────────────────────────────────

  /**
   * latencyMs ← median p50 during low-load slots.
   *
   * Low-load slots isolate the service's inherent latency from queueing delay,
   * which is already captured separately by the loadDriven delay type.
   */
  private deriveLatencyMs(m: EndpointObservedMetrics): number {
    return Math.max(1, Math.round(m.baselineP50Ms));
  }

  /**
   * jitterMs ← baselineP95 - baselineP50 during low-load slots.
   *
   * This captures natural variance (GC pauses, I/O hiccups) without
   * conflating it with load-driven latency amplification.
   * Clamped to [0, latencyMs] to keep LogNormal params valid.
   */
  private deriveJitterMs(m: EndpointObservedMetrics): number {
    const raw = Math.max(0, m.baselineJitterMs);
    const latency = Math.max(1, m.baselineP50Ms);
    // Cap jitter at latencyMs to keep sigma reasonable for LogNormal
    return Math.round(Math.min(raw, latency * 0.8));
  }

  /**
   * errorRate ← median error rate across non-gap slots (0–1).
   *
   * Median is used instead of mean to be robust against transient
   * fault injection spikes that would inflate the mean.
   */
  private deriveErrorRate(m: EndpointObservedMetrics): number {
    // Round to 4 decimal places (e.g. 0.0023)
    return Math.round(m.medianErrorRate * 10000) / 10000;
  }

  /**
   * capacityPerReplica ← (peakRps / fanOutFactor) / replicaCountAtPeak
   *
   * Fan-out correction is critical: k6 counts all HTTP calls including
   * internal service-to-service calls. Without correction, capacityPerReplica
   * is inflated by the fan-out multiplier, causing simulated replica counts
   * to be too low at peak load.
   *
   * Unit: requests/second per replica — duration-independent, so it needs no
   * conversion when the emitted config is replayed at hourly resolution.
   */
  private deriveCapacityPerReplica(m: EndpointObservedMetrics): number {
    const fanOut = this.fanOutFactors[m.service] ?? 1;
    const correctedPeakRps = m.peakRps / fanOut;
    const replicas = Math.max(1, m.replicaCountAtPeak);
    const raw = correctedPeakRps / replicas;
    // Round to 2 decimal places; ensure at least 0.01
    return Math.max(0.01, Math.round(raw * 100) / 100);
  }

  /**
   * Drift derivation.
   *
   * ── UNITS (the subtle part) ────────────────────────────────────────────────
   * MetricsExtractor regresses p50 over the slot INDEX, so `driftSlopeMsPerSlot` is
   * ms per calibration slot, whose wall-clock length depends on the CSV's sampling
   * rate. `driftDetectionThresholdMs` is documented in ms/HOUR. Comparing the raw
   * per-slot slope against it would make drift detection depend on sampling rate: a
   * genuine 120 ms/hour drift is only a 2 ms/slot slope at 1-minute resolution, landing
   * right on the default 2.0 threshold instead of 60× above it.
   *
   * So: normalise to ms/hour FIRST, threshold on that, and keep the per-slot rate for
   * the calibration simulation (advanceDrift runs once per slot).
   *
   * gradualDrift can only model latency getting WORSE over time (driftRate is clamped
   * >= 0 by the schema and only ever added to latencyMs — see
   * LatencySimulator.computeGradualDrift). A negative slope means latency is improving,
   * which this delay type cannot represent; treating it as "drift" would select
   * gradualDrift with driftRate forced to 0 — a no-op entry that misleadingly reports
   * "drift detected" for nothing.
   *
   * driftMode inference:
   *   - RPS always > 0 (continuous traffic) → "request" (connection pool / thread
   *     starvation is the more common root cause; time vs request is indistinguishable
   *     from the data alone).
   *   - Zero-traffic gaps with p50 still rising across them → "time" (e.g. memory leak).
   *   - Zero-traffic gaps with p50 falling back → "request-with-recovery".
   */
  private deriveDrift(m: EndpointObservedMetrics): {
    hasDrift: boolean;
    driftRatePerSlot: number;
    driftMode: "time" | "request" | "request-with-recovery";
    diagnostics: DerivationDiagnostics;
  } {
    const slotsPerHour = slotsPerHourFor(m.slotDurationSeconds);
    const rpsValues = m.slotStats.filter(s => !s.isGap).map(s => s.rps);
    const rpsCV = this.coefficientOfVariation(rpsValues);

    const baseDiagnostics = {
      rpsCoeffOfVariation: rpsCV,
      lowLoadThresholdPct: this.lowLoadThresholdPct,
    };

    // Too few slots to fit a trend to. Suppress the pattern inference rather than
    // reporting a slope fitted to two points as if it meant something.
    if (m.slotStats.length < MetricsExtractor.MIN_SLOTS_FOR_STATS) {
      return {
        hasDrift: false,
        driftRatePerSlot: 0,
        driftMode: "request",
        diagnostics: {
          ...baseDiagnostics,
          rawDriftSlopeMsPerHour: 0,
          isDriftMonotonic: false,
          driftConfidence: "none",
          insufficientSlots: true,
        },
      };
    }

    // The ONLY value that gets thresholded, and the only one in diagnostics.
    const slopeMsPerHour = m.driftSlopeMsPerSlot * slotsPerHour;
    const isPositiveDrift = slopeMsPerHour > this.driftThreshold;

    // Gap detection walks the FULL array: adjacency is the whole point.
    const hasZeroRpsSlots = m.slotStats.some(s => s.rps < 0.01);
    const isDriftMonotonic = this.checkDriftMonotonicity(m.slotStats);

    let driftConfidence: "none" | "weak" | "strong";
    if (!isPositiveDrift) {
      driftConfidence = "none";
    } else if (m.observedSpanSeconds < 3600) {
      // A trend fitted entirely inside one hour is not evidence of an hourly trend,
      // however steep it looks — the emitted per-hour rate is pure extrapolation.
      driftConfidence = "weak";
    } else if (slopeMsPerHour < this.driftThreshold * 3) {
      driftConfidence = "weak";
    } else {
      driftConfidence = "strong";
    }

    let driftMode: "time" | "request" | "request-with-recovery" = "request";
    if (isPositiveDrift) {
      if (!hasZeroRpsSlots) {
        driftMode = "request";
      } else if (isDriftMonotonic) {
        driftMode = "time";
      } else {
        driftMode = "request-with-recovery";
      }
    }

    // Calibration unit: ms per slot, applied once per slot by advanceDrift.
    const driftRatePerSlot = isPositiveDrift
      ? Math.max(0, Math.round(m.driftSlopeMsPerSlot * 10000) / 10000)
      : 0;

    return {
      hasDrift: isPositiveDrift,
      driftRatePerSlot,
      driftMode,
      diagnostics: {
        ...baseDiagnostics,
        rawDriftSlopeMsPerHour: slopeMsPerHour,
        isDriftMonotonic,
        driftConfidence,
        insufficientSlots: false,
      },
    };
  }

  // ─── Drift pattern analysis ────────────────────────────────────────────────

  /**
   * Checks whether p50 latency grows monotonically across zero-RPS gaps.
   *
   * Strategy: find slots where RPS ≈ 0, then check if p50 before and after
   * the gap shows a non-negative delta. If yes across most gaps → time-driven drift.
   *
   * Walks the full array (including isGap slots) because it reasons purely about
   * temporal adjacency — that's exactly what carry-forward gap filling preserves.
   */
  private checkDriftMonotonicity(slotStats: TimeSlotStats[]): boolean {
    if (slotStats.length < 3) return false;

    const gaps: number[] = []; // indices of zero-RPS slots

    for (let i = 0; i < slotStats.length; i++) {
      if (slotStats[i].rps < 0.01) gaps.push(i);
    }

    if (gaps.length === 0) {
      // No gaps: check if p50 is monotonically non-decreasing overall
      let increases = 0;
      for (let i = 1; i < slotStats.length; i++) {
        if (slotStats[i].p50Ms >= slotStats[i - 1].p50Ms) increases++;
      }
      return increases / (slotStats.length - 1) >= 0.7;
    }

    // With gaps: p50 after gap should be >= p50 before gap (no recovery)
    let monotonicGaps = 0;
    let comparableGaps = 0;
    for (const gapIdx of gaps) {
      const before = gapIdx > 0 ? slotStats[gapIdx - 1].p50Ms : null;
      const after  = gapIdx < slotStats.length - 1
        ? slotStats[gapIdx + 1].p50Ms
        : null;

      if (before !== null && after !== null) {
        comparableGaps++;
        if (after >= before * 0.95) monotonicGaps++; // 5% tolerance
      }
    }

    return comparableGaps > 0 && monotonicGaps / comparableGaps >= 0.6;
  }

  // ─── Math helpers ──────────────────────────────────────────────────────────

  private coefficientOfVariation(values: number[]): number {
    if (values.length === 0) return 0;
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    if (mean === 0) return 0;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance) / mean;
  }
}
