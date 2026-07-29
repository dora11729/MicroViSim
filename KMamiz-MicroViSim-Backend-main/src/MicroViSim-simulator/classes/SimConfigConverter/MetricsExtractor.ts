/**
 * Standard CSV format (one row per time slot per endpoint):
 *   timestamp,service,endpoint,rps,p50_ms,p95_ms,error_rate,replica_count
 *   2024-01-01T00:00:00Z,auth-service,POST /login,42.3,85,210,0.002,2
 * 
*/

import { RawMetricRow, HourlyStats, EndpointObservedMetrics } from "../../entities/TSimConfigConverter";

export class MetricsExtractor {
  /**
   * Main entry point.
   * @param csvText - Raw text content of the standard MicroViSim CSV file.
   * @returns Map keyed by "service::endpoint"
   */
  extract(csvText: string): Map<string, EndpointObservedMetrics> {
    const rows = this.parseCsv(csvText);
    const grouped = this.groupByEndpoint(rows);
    const result = new Map<string, EndpointObservedMetrics>();

    for (const [key, endpointRows] of grouped.entries()) {
      result.set(key, this.deriveEndpointMetrics(endpointRows));
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

    const header = lines[0].split(",").map(h => h.trim().toLowerCase());
    this.validateHeader(header);

    const rows: RawMetricRow[] = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",").map(c => c.trim());
      if (cols.length !== header.length) continue; // skip malformed rows

      try {
        rows.push({
          timestamp:    new Date(cols[header.indexOf("timestamp")]),
          service:      cols[header.indexOf("service")],
          endpoint:     cols[header.indexOf("endpoint")],
          rps:          parseFloat(cols[header.indexOf("rps")]),
          p50Ms:        parseFloat(cols[header.indexOf("p50_ms")]),
          p95Ms:        parseFloat(cols[header.indexOf("p95_ms")]),
          errorRate:    parseFloat(cols[header.indexOf("error_rate")]),
          replicaCount: parseInt(cols[header.indexOf("replica_count")], 10),
        });
      } catch {
        // skip unparseable rows silently
      }
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

  // ─── Derivation ────────────────────────────────────────────────────────────

  private deriveEndpointMetrics(rows: RawMetricRow[]): EndpointObservedMetrics {
    const sorted = [...rows].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const hourlyStats = this.aggregateByHour(sorted);

    const peakHour = hourlyStats.reduce((max, h) => h.rps > max.rps ? h : max, hourlyStats[0]);
    const peakRps = peakHour.rps;
    const replicaCountAtPeak = peakHour.replicaCount;

    // Low-load hours: below 50% of peak RPS
    const lowLoadHours = hourlyStats.filter(h => h.rps < peakRps * 0.5);
    const baselineHours = lowLoadHours.length > 0 ? lowLoadHours : hourlyStats;

    const baselineP50Ms  = this.median(baselineHours.map(h => h.p50Ms));
    const baselineP95Ms  = this.median(baselineHours.map(h => h.p95Ms));
    const medianErrorRate = this.median(hourlyStats.map(h => h.errorRate));
    const driftSlopeMs   = this.linearRegressionSlope(hourlyStats.map(h => h.p50Ms));

    return {
      service:  sorted[0].service,
      endpoint: sorted[0].endpoint,
      hourlyStats,
      baselineP50Ms,
      baselineP95Ms,
      baselineJitterMs: Math.max(0, baselineP95Ms - baselineP50Ms),
      peakRps,
      replicaCountAtPeak,
      medianErrorRate,
      driftSlopeMs,
    };
  }

  /**
   * Bucket rows into hours (0–23), take the median of each metric within each bucket.
   * Works for both sub-hourly (e.g. per-minute) and hourly CSV data.
   *
   * Always returns a fixed-length 24-element array indexed by true hour-of-day, so
   * downstream consumers that access by array index (SimulatorRunnerAdapter's hourly
   * loop, ConverterService.computeMape, ParameterDeriver's regression/monotonicity
   * checks) stay correctly aligned even when some hour has zero observed rows —
   * omitting empty hours would compact the array and shift every later hour's data
   * into the wrong index.
   */
  private aggregateByHour(sorted: RawMetricRow[]): HourlyStats[] {
    const buckets = new Map<number, RawMetricRow[]>();

    for (const row of sorted) {
      const hour = row.timestamp.getUTCHours();
      if (!buckets.has(hour)) buckets.set(hour, []);
      buckets.get(hour)!.push(row);
    }

    const result: HourlyStats[] = [];
    let lastKnownP50 = this.median(sorted.map(r => r.p50Ms));
    let lastKnownP95 = this.median(sorted.map(r => r.p95Ms));
    let lastKnownReplica = Math.round(this.median(sorted.map(r => r.replicaCount)));

    for (let hour = 0; hour < 24; hour++) {
      const rows = buckets.get(hour);
      if (rows && rows.length > 0) {
        lastKnownP50 = this.median(rows.map(r => r.p50Ms));
        lastKnownP95 = this.median(rows.map(r => r.p95Ms));
        lastKnownReplica = Math.round(this.median(rows.map(r => r.replicaCount)));
        result.push({
          hour,
          rps:          this.median(rows.map(r => r.rps)),
          p50Ms:        lastKnownP50,
          p95Ms:        lastKnownP95,
          errorRate:    this.median(rows.map(r => r.errorRate)),
          replicaCount: lastKnownReplica,
        });
      } else {
        // Gap hour: no rows observed for this hour-of-day anywhere in the dataset.
        // rps/errorRate → 0 (no traffic really happened, don't fabricate load/error);
        // p50/p95/replicaCount → carry forward from the nearest previous real hour
        // (falling back to the overall median for a leading gap) so the gap doesn't
        // look like a fake latency cliff to the regression/monotonicity/grid-search
        // consumers downstream.
        result.push({
          hour,
          rps: 0,
          p50Ms: lastKnownP50,
          p95Ms: lastKnownP95,
          errorRate: 0,
          replicaCount: lastKnownReplica,
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
   * Simple OLS linear regression slope (y over index).
   * Used to estimate driftRate: how much p50 increases per hour on average.
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