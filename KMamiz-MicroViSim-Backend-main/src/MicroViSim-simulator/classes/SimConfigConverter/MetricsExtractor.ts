/**
 * Layer 1 of the Auto-Converter pipeline.
 *
 * Standard CSV format (one row per sample per endpoint):
 *   timestamp,service,endpoint,rps,p50_ms,p95_ms,error_rate,replica_count
 *   2024-01-01T00:00:00Z,auth-service,POST /login,42.3,85,210,0.002,2
 *
 * Rows are bucketed into contiguous fixed-duration time slots whose length is derived
 * from the CSV's own sampling interval — NOT forced to 24 hourly buckets. Most load
 * tests span minutes, and forcing them into a 24-hour grid collapsed every real sample
 * into one bucket and filled the other 23 synthetically, which degenerated the entire
 * downstream pipeline (constant p50 ⇒ zero correlation, zero regression slope, zero
 * variance ⇒ loadDriven/gradualDrift/jitter became unselectable, and the latency MAPE
 * bottomed out at ~95.8% no matter the candidate).
 */

import {
  RawMetricRow,
  TimeSlotStats,
  SlotGrid,
  EndpointObservedMetrics,
} from "../../entities/TSimConfigConverter";
import { parseCsvLine } from "./CsvLineParser";

export class MetricsExtractor {
  /**
   * Hard ceiling on slots per endpoint. Grid-search cost is
   * O(slotCount × searchSteps² × mapeSamplesPerCandidate), so this bounds a whole run.
   */
  static readonly MAX_SLOTS = 120;

  /**
   * Below this many slots, pattern detection (correlation / regression / spike runs)
   * has too few points to mean anything; the endpoint degrades to `stable`.
   */
  static readonly MIN_SLOTS_FOR_STATS = 6;

  /**
   * Preferred floor. The k6 path is already 1-minute aggregated (K6CsvConverter emits
   * one row per minute), and below a minute `rps × slotDuration` rounds to a handful of
   * requests, so per-slot medians stop being estimates of anything.
   */
  static readonly PREFERRED_MIN_SLOT_SECONDS = 60;

  /** Absolute floor, for sub-minute smoke tests too short to coarsen. */
  static readonly ABSOLUTE_MIN_SLOT_SECONDS = 1;

  /**
   * Main entry point.
   * @param csvText - Raw text content of the standard MicroViSim CSV file.
   * @param lowLoadThresholdPct - Slots with RPS below (peak × this) are used for the
   *   baseline (latencyMs/jitterMs) computation. Must match what's passed to
   *   ParameterDeriver so its diagnostics.lowLoadThresholdPct reflects what was
   *   actually applied here, rather than a value that was only ever echoed back.
   * @param slotDurationSecondsOverride - Force a specific slot duration instead of
   *   deriving one from the data.
   * @returns Map keyed by "service::endpoint"
   */
  extract(
    csvText: string,
    lowLoadThresholdPct: number = 0.5,
    slotDurationSecondsOverride?: number,
  ): Map<string, EndpointObservedMetrics> {
    const rows = this.parseCsv(csvText);
    const grouped = this.groupByEndpoint(rows);

    // One grid for the whole CSV so every endpoint shares the same slot DURATION and
    // per-slot units stay comparable. Each endpoint still gets its own WINDOW below.
    const grid = this.chooseSlotGrid(rows, slotDurationSecondsOverride);

    const result = new Map<string, EndpointObservedMetrics>();
    for (const [key, endpointRows] of grouped.entries()) {
      result.set(key, this.deriveEndpointMetrics(endpointRows, lowLoadThresholdPct, grid));
    }

    return result;
  }

  // ─── CSV Parsing ───────────────────────────────────────────────────────────

  private parseCsv(csvText: string): RawMetricRow[] {
    const lines = csvText
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.length > 0);

    if (lines.length < 2) {
      throw new Error("CSV must have a header row and at least one data row.");
    }

    const header = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());
    this.validateHeader(header);

    const rows: RawMetricRow[] = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i]).map(c => c.trim());
      if (cols.length !== header.length) continue; // skip malformed rows

      const timestamp    = new Date(cols[header.indexOf("timestamp")]);
      const rps          = parseFloat(cols[header.indexOf("rps")]);
      const p50Ms        = parseFloat(cols[header.indexOf("p50_ms")]);
      const p95Ms        = parseFloat(cols[header.indexOf("p95_ms")]);
      const errorRate    = parseFloat(cols[header.indexOf("error_rate")]);
      const replicaCount = parseInt(cols[header.indexOf("replica_count")], 10);

      // parseFloat/parseInt/new Date don't throw on bad input — they produce NaN /
      // Invalid Date, which would otherwise silently poison every median/regression
      // downstream. Skip the row instead, consistent with the column-count check above.
      if (
        isNaN(timestamp.getTime()) ||
        isNaN(rps) || isNaN(p50Ms) || isNaN(p95Ms) ||
        isNaN(errorRate) || isNaN(replicaCount)
      ) {
        continue;
      }

      rows.push({
        timestamp,
        service:  cols[header.indexOf("service")],
        endpoint: cols[header.indexOf("endpoint")],
        rps,
        p50Ms,
        p95Ms,
        errorRate,
        replicaCount,
      });
    }

    if (rows.length === 0) {
      throw new Error("CSV contained no parseable data rows.");
    }

    return rows;
  }

  private validateHeader(header: string[]): void {
    const required = ["timestamp", "service", "endpoint", "rps", "p50_ms", "p95_ms", "error_rate", "replica_count"];
    const missing = required.filter(col => !header.includes(col));
    if (missing.length > 0) {
      throw new Error(`CSV is missing required columns: ${missing.join(", ")}`);
    }
  }

  // ─── Grouping ──────────────────────────────────────────────────────────────

  private groupByEndpoint(rows: RawMetricRow[]): Map<string, RawMetricRow[]> {
    const map = new Map<string, RawMetricRow[]>();
    for (const row of rows) {
      const key = `${row.service}::${row.endpoint}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(row);
    }
    return map;
  }

  // ─── Slot grid selection ───────────────────────────────────────────────────

  /**
   * Picks the slot duration for the whole CSV.
   *
   * Start from the finest resolution the data actually supports, prefer at least one
   * minute, and cap the total slot count so grid-search cost stays bounded.
   */
  chooseSlotGrid(rows: RawMetricRow[], override?: number): SlotGrid {
    const times = Array.from(new Set(rows.map(r => r.timestamp.getTime()))).sort((a, b) => a - b);
    const observedSpanSeconds = times.length > 1
      ? (times[times.length - 1] - times[0]) / 1000
      : 0;

    // Native sampling interval = median positive gap between consecutive DISTINCT
    // timestamps. Median rather than min/mean so one missing sample or a burst of
    // duplicated timestamps doesn't move it.
    const deltas: number[] = [];
    for (let i = 1; i < times.length; i++) deltas.push((times[i] - times[i - 1]) / 1000);
    const nativeIntervalSeconds = deltas.length > 0
      ? Math.max(MetricsExtractor.ABSOLUTE_MIN_SLOT_SECONDS, Math.round(this.median(deltas)))
      : MetricsExtractor.PREFERRED_MIN_SLOT_SECONDS;

    if (override && override > 0) {
      return {
        slotDurationSeconds: Math.max(MetricsExtractor.ABSOLUTE_MIN_SLOT_SECONDS, Math.round(override)),
        nativeIntervalSeconds,
        observedSpanSeconds,
        reason: `explicit slotDurationSeconds=${Math.round(override)}s`,
      };
    }

    let duration = nativeIntervalSeconds;
    let reason = `native CSV sampling interval (${duration}s)`;

    // Prefer >= 60s, but only when coarsening still leaves enough slots to fit a trend to.
    if (duration < MetricsExtractor.PREFERRED_MIN_SLOT_SECONDS) {
      const coarse = Math.ceil(MetricsExtractor.PREFERRED_MIN_SLOT_SECONDS / duration) * duration;
      if (this.slotCountFor(observedSpanSeconds, coarse) >= MetricsExtractor.MIN_SLOTS_FOR_STATS) {
        reason = `native interval ${duration}s coarsened to ${coarse}s (1-minute floor)`;
        duration = coarse;
      } else {
        reason = `native interval ${duration}s kept below the 1-minute floor: coarsening would ` +
                 `leave fewer than ${MetricsExtractor.MIN_SLOTS_FOR_STATS} slots`;
      }
    }

    // Cap the slot count. Round up to a whole multiple of the native interval so every
    // slot still holds the same number of source rows — otherwise slot sample counts
    // alternate between n and n+1 and the medians pick up a sawtooth.
    if (this.slotCountFor(observedSpanSeconds, duration) > MetricsExtractor.MAX_SLOTS) {
      const needed = observedSpanSeconds / (MetricsExtractor.MAX_SLOTS - 1);
      duration = Math.ceil(needed / nativeIntervalSeconds) * nativeIntervalSeconds;
      reason = `span ${Math.round(observedSpanSeconds)}s capped to ${MetricsExtractor.MAX_SLOTS} ` +
               `slots → ${duration}s per slot`;
    }

    return {
      slotDurationSeconds: Math.max(MetricsExtractor.ABSOLUTE_MIN_SLOT_SECONDS, duration),
      nativeIntervalSeconds,
      observedSpanSeconds,
      reason,
    };
  }

  private slotCountFor(spanSeconds: number, slotDurationSeconds: number): number {
    return Math.floor(spanSeconds / Math.max(1, slotDurationSeconds)) + 1;
  }

  // ─── Derivation ────────────────────────────────────────────────────────────

  private deriveEndpointMetrics(
    rows: RawMetricRow[],
    lowLoadThresholdPct: number,
    grid: SlotGrid,
  ): EndpointObservedMetrics {
    const sorted = [...rows].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const slotStats = this.aggregateBySlot(sorted, grid.slotDurationSeconds);

    // This endpoint's OWN observed window, not the CSV-wide span — see aggregateBySlot.
    const observedSpanSeconds =
      (sorted[sorted.length - 1].timestamp.getTime() - sorted[0].timestamp.getTime()) / 1000;

    const peakSlot = slotStats.reduce((max, s) => s.rps > max.rps ? s : max, slotStats[0]);
    const peakRps = peakSlot.rps;
    const replicaCountAtPeak = peakSlot.replicaCount;

    // Baseline and error-rate statistics summarise OBSERVED behaviour, so they must
    // ignore gap slots — whose p50/p95 are carried forward and whose errorRate is a
    // synthetic 0. (Including synthetic zeros is what used to drag medianErrorRate to 0
    // for every short CSV.)
    const realSlots = slotStats.filter(s => !s.isGap);
    const lowLoadSlots = realSlots.filter(s => s.rps < peakRps * lowLoadThresholdPct);
    const baselineSlots = lowLoadSlots.length > 0 ? lowLoadSlots : realSlots;

    const baselineP50Ms   = this.median(baselineSlots.map(s => s.p50Ms));
    const baselineP95Ms   = this.median(baselineSlots.map(s => s.p95Ms));
    const medianErrorRate = this.median(realSlots.map(s => s.errorRate));

    // Regression walks the FULL array: the index has to stay a linear time axis, and
    // gap slots carry forward p50 precisely so they don't punch holes in the trend.
    // Unit is ms per SLOT; ParameterDeriver normalises to ms/hour before thresholding.
    const driftSlopeMsPerSlot = this.linearRegressionSlope(slotStats.map(s => s.p50Ms));

    return {
      service:  sorted[0].service,
      endpoint: sorted[0].endpoint,
      slotStats,
      slotDurationSeconds: grid.slotDurationSeconds,
      nativeIntervalSeconds: grid.nativeIntervalSeconds,
      slotGridReason: grid.reason,
      observedSpanSeconds,
      baselineP50Ms,
      baselineP95Ms,
      baselineJitterMs: Math.max(0, baselineP95Ms - baselineP50Ms),
      peakRps,
      replicaCountAtPeak,
      medianErrorRate,
      driftSlopeMsPerSlot,
    };
  }

  /**
   * Buckets one endpoint's rows into contiguous fixed-duration slots covering exactly
   * that endpoint's own window (its first row → its last row).
   *
   * Per-endpoint windowing matters: an endpoint that only appears in the last 5 minutes
   * of a 2-hour test would otherwise get ~115 synthetic gap slots, reintroducing the
   * very bug this replaces. A shared slot DURATION is enough to keep units coherent.
   *
   * Consequence: the first and last slot always contain real rows, so leading and
   * trailing gaps are impossible by construction.
   */
  private aggregateBySlot(sorted: RawMetricRow[], slotDurationSeconds: number): TimeSlotStats[] {
    const startMs = sorted[0].timestamp.getTime();
    const endMs = sorted[sorted.length - 1].timestamp.getTime();
    const slotMs = Math.max(1, slotDurationSeconds) * 1000;
    const slotCount = Math.floor((endMs - startMs) / slotMs) + 1;

    const buckets = new Map<number, RawMetricRow[]>();
    for (const row of sorted) {
      const idx = Math.min(slotCount - 1, Math.floor((row.timestamp.getTime() - startMs) / slotMs));
      if (!buckets.has(idx)) buckets.set(idx, []);
      buckets.get(idx)!.push(row);
    }

    const result: TimeSlotStats[] = [];
    // Seeds are only used if slot 0 were empty, which per-endpoint windowing prevents.
    let lastKnownP50 = this.median(sorted.map(r => r.p50Ms));
    let lastKnownP95 = this.median(sorted.map(r => r.p95Ms));
    let lastKnownReplica = Math.round(this.median(sorted.map(r => r.replicaCount)));

    for (let slotIndex = 0; slotIndex < slotCount; slotIndex++) {
      const rows = buckets.get(slotIndex);

      if (rows && rows.length > 0) {
        lastKnownP50 = this.median(rows.map(r => r.p50Ms));
        lastKnownP95 = this.median(rows.map(r => r.p95Ms));
        lastKnownReplica = Math.round(this.median(rows.map(r => r.replicaCount)));
        result.push({
          slotIndex,
          rps:          this.median(rows.map(r => r.rps)),
          p50Ms:        lastKnownP50,
          p95Ms:        lastKnownP95,
          errorRate:    this.median(rows.map(r => r.errorRate)),
          replicaCount: lastKnownReplica,
          isGap: false,
        });
      } else {
        // Genuinely missing sample mid-test. rps/errorRate → 0 (don't fabricate traffic
        // or errors); p50/p95/replicaCount carried forward so the index→time axis stays
        // linear and the OLS slope doesn't read a fake cliff to zero as huge negative
        // drift. `isGap` marks these as non-observations for every summary statistic.
        result.push({
          slotIndex,
          rps: 0,
          p50Ms: lastKnownP50,
          p95Ms: lastKnownP95,
          errorRate: 0,
          replicaCount: lastKnownReplica,
          isGap: true,
        });
      }
    }

    return result;
  }

  // ─── Math helpers ──────────────────────────────────────────────────────────

  private median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  /**
   * Simple OLS linear regression slope (y over array index).
   * Unit is "per index step" = per slot; the caller converts to ms/hour.
   */
  private linearRegressionSlope(values: number[]): number {
    const n = values.length;
    if (n < 2) return 0;

    const xMean = (n - 1) / 2;
    const yMean = values.reduce((s, v) => s + v, 0) / n;

    let numerator = 0;
    let denominator = 0;

    for (let i = 0; i < n; i++) {
      numerator   += (i - xMean) * (values[i] - yMean);
      denominator += (i - xMean) ** 2;
    }

    return denominator === 0 ? 0 : numerator / denominator;
  }
}
