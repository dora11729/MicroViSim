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
 *   latencyMs          ← baselineP50Ms  (median p50 during low-load hours)
 *   jitterMs           ← baselineJitterMs (baselineP95 - baselineP50)
 *   errorRate          ← medianErrorRate
 *   capacityPerReplica ← peakRps / replicaCountAtPeak  (corrected for fan-out)
 *   driftRate          ← driftSlopeMs / slotsPerHour   (ms per time slot)
 *   driftMode          ← inferred from drift pattern (monotonic vs sawtooth)
 */

import { EndpointObservedMetrics, HourlyStats, DerivedEndpointParams, DerivationDiagnostics, ParameterDeriverOptions } from "../../entities/TSimConfigConverter";

export class ParameterDeriver {
  private readonly slotsPerHour: number;
  private readonly fanOutFactors: Record<string, number>;
  private readonly driftThreshold: number;
  private readonly lowLoadThresholdPct: number;

  constructor(options: ParameterDeriverOptions = {}) {
    this.slotsPerHour       = options.slotsPerHour ?? 1;
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
      driftRate,
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
      driftRate,
      driftMode,
      diagnostics,
    };
  }

  // ─── Individual parameter derivations ─────────────────────────────────────

  /**
   * latencyMs ← median p50 during low-load hours.
   *
   * Low-load hours isolate the service's inherent latency from queueing delay,
   * which is already captured separately by the loadDriven delay type.
   */
  private deriveLatencyMs(m: EndpointObservedMetrics): number {
    return Math.max(1, Math.round(m.baselineP50Ms));
  }

  /**
   * jitterMs ← baselineP95 - baselineP50 during low-load hours.
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
   * errorRate ← median error rate across all hours (0–1).
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
   * Unit: requests/second per replica
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
   * Drift derivation:
   *   driftRate  ← driftSlopeMs (ms/hour) / slotsPerHour → ms/slot
   *   driftMode  ← inferred from RPS continuity pattern
   *   hasDrift   ← slope exceeds driftDetectionThreshold
   *
   * driftMode inference logic:
   *   - If RPS is always > 0 (continuous traffic) → "time" or "request" both work,
   *     default to "request" (more physically accurate for most root causes).
   *   - If RPS has zero-traffic gaps → "request-with-recovery" if drift resets
   *     after gaps, "request" if drift freezes (stays flat during gaps).
   *   - Monotonic p50 growth despite gaps → "time" (time-driven, e.g. memory leak).
   */
  private deriveDrift(m: EndpointObservedMetrics): {
    hasDrift: boolean;
    driftRate: number;
    driftMode: "time" | "request" | "request-with-recovery";
    diagnostics: DerivationDiagnostics;
  } {
    const slope = m.driftSlopeMs;
    const aboveThreshold = Math.abs(slope) > this.driftThreshold;

    const rpsValues = m.hourlyStats.map(h => h.rps);
    const rpsCV = this.coefficientOfVariation(rpsValues);
    const hasZeroRpsHours = rpsValues.some(r => r < 0.01);
    const isDriftMonotonic = this.checkDriftMonotonicity(m.hourlyStats);

    // Drift confidence
    let driftConfidence: "none" | "weak" | "strong";
    if (!aboveThreshold) {
      driftConfidence = "none";
    } else if (Math.abs(slope) < this.driftThreshold * 3) {
      driftConfidence = "weak";
    } else {
      driftConfidence = "strong";
    }

    // driftMode inference
    let driftMode: "time" | "request" | "request-with-recovery" = "request";
    if (aboveThreshold) {
      if (!hasZeroRpsHours) {
        // Continuous traffic: can't distinguish time vs request from data alone.
        // Default to "request" (connection pool / thread starvation is more common).
        driftMode = "request";
      } else if (isDriftMonotonic) {
        // p50 keeps rising even during zero-traffic hours → time-driven (memory leak)
        driftMode = "time";
      } else {
        // p50 partially resets during zero-traffic hours → recovery pattern
        driftMode = "request-with-recovery";
      }
    }

    // Convert slope from ms/hour to ms/slot
    const driftRatePerSlot = aboveThreshold
      ? Math.max(0, Math.round((slope / this.slotsPerHour) * 100) / 100)
      : 0;

    return {
      hasDrift: aboveThreshold,
      driftRate: driftRatePerSlot,
      driftMode,
      diagnostics: {
        rawDriftSlopeMsPerHour: slope,
        isDriftMonotonic,
        rpsCoeffOfVariation: rpsCV,
        driftConfidence,
        lowLoadThresholdPct: this.lowLoadThresholdPct,
      },
    };
  }

  // ─── Drift pattern analysis ────────────────────────────────────────────────

  /**
   * Checks whether p50 latency grows monotonically across zero-RPS gaps.
   *
   * Strategy: find hours where RPS ≈ 0, then check if p50 before and after
   * the gap shows a positive delta. If yes across most gaps → time-driven drift.
   */
  private checkDriftMonotonicity(hourlyStats: HourlyStats[]): boolean {
    if (hourlyStats.length < 3) return false;

    const gaps: number[] = []; // indices of zero-RPS hours

    for (let i = 0; i < hourlyStats.length; i++) {
      if (hourlyStats[i].rps < 0.01) gaps.push(i);
    }

    if (gaps.length === 0) {
      // No gaps: check if p50 is monotonically non-decreasing overall
      let increases = 0;
      for (let i = 1; i < hourlyStats.length; i++) {
        if (hourlyStats[i].p50Ms >= hourlyStats[i - 1].p50Ms) increases++;
      }
      return increases / (hourlyStats.length - 1) >= 0.7;
    }

    // With gaps: p50 after gap should be >= p50 before gap (no recovery)
    let monotonicGaps = 0;
    for (const gapIdx of gaps) {
      const before = gapIdx > 0 ? hourlyStats[gapIdx - 1].p50Ms : null;
      const after  = gapIdx < hourlyStats.length - 1
        ? hourlyStats[gapIdx + 1].p50Ms
        : null;

      if (before !== null && after !== null) {
        if (after >= before * 0.95) monotonicGaps++; // 5% tolerance
      }
    }

    return gaps.length > 0 && monotonicGaps / gaps.length >= 0.6;
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