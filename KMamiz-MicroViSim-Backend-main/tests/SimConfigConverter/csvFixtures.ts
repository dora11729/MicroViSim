/**
 * Shared CSV builders for the Auto-Converter tests.
 *
 * Everything here produces the standard MicroViSim CSV format:
 *   timestamp,service,endpoint,rps,p50_ms,p95_ms,error_rate,replica_count
 */

export const CSV_HEADER =
  "timestamp,service,endpoint,rps,p50_ms,p95_ms,error_rate,replica_count";

export interface SampleSpec {
  /** Seconds since the start of the test. */
  offsetSeconds: number;
  rps?: number;
  p50Ms?: number;
  p95Ms?: number;
  errorRate?: number;
  replicaCount?: number;
}

const BASE_MS = Date.UTC(2024, 0, 1, 0, 0, 0);

export function buildCsv(
  samples: SampleSpec[],
  service = "auth-service",
  endpoint = "POST /login",
): string {
  const rows = samples.map(s => {
    const ts = new Date(BASE_MS + s.offsetSeconds * 1000).toISOString();
    return [
      ts,
      service,
      endpoint,
      (s.rps ?? 10).toString(),
      (s.p50Ms ?? 100).toString(),
      (s.p95Ms ?? 150).toString(),
      (s.errorRate ?? 0).toString(),
      (s.replicaCount ?? 2).toString(),
    ].join(",");
  });
  return [CSV_HEADER, ...rows].join("\n");
}

/**
 * Evenly-spaced samples.
 * @param count       number of samples
 * @param intervalSec spacing between samples
 * @param at          per-sample field overrides, given the sample index
 */
export function buildEvenCsv(
  count: number,
  intervalSec: number,
  at: (i: number) => Omit<SampleSpec, "offsetSeconds"> = () => ({}),
  service?: string,
  endpoint?: string,
): string {
  const samples: SampleSpec[] = [];
  for (let i = 0; i < count; i++) {
    samples.push({ offsetSeconds: i * intervalSec, ...at(i) });
  }
  return buildCsv(samples, service, endpoint);
}

/**
 * A dataset whose p50 rises at a fixed ms-per-HOUR rate, sampled at an arbitrary
 * interval. Used to prove drift detection is invariant to sampling rate.
 */
export function buildDriftCsv(opts: {
  msPerHour: number;
  intervalSec: number;
  spanSeconds: number;
  baseP50?: number;
}): string {
  const { msPerHour, intervalSec, spanSeconds, baseP50 = 100 } = opts;
  const count = Math.floor(spanSeconds / intervalSec) + 1;
  return buildEvenCsv(count, intervalSec, i => {
    const elapsedHours = (i * intervalSec) / 3600;
    const p50 = baseP50 + msPerHour * elapsedHours;
    return { rps: 10, p50Ms: p50, p95Ms: p50 * 1.4, errorRate: 0, replicaCount: 2 };
  });
}
