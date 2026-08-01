/**
 * K6CsvConverter.ts
 *
 * Converts k6 raw CSV output (--out csv) to the MicroViSim standard CSV format.
 *
 * k6 raw CSV columns:
 *   metric_name,timestamp,metric_value,check,error,error_code,expected_response,
 *   group,method,name,proto,scenario,service,status,subproto,tls_version,url
 *
 * Standard format:
 *   timestamp,service,endpoint,rps,p50_ms,p95_ms,error_rate,replica_count
 * 
 * Relevant metric_name values:
 *   http_req_duration   → p50 / p95 latency
 *   http_reqs           → RPS
 *   http_req_failed     → error rate
 *
 * Usage:
 *   const standardCsv = new K6CsvConverter().convert(k6RawCsv, serviceEndpointMap);
 *   const metrics = new MetricsExtractor().extract(standardCsv);
 */

import { parseCsvLine } from "./CsvLineParser";

export interface K6ServiceEndpointConfig {
  /**
   * Maps k6 request name (the `name` tag in k6 output) to service + endpoint.
   *
   * Example:
   *   "POST http://localhost:8080/api/login" → { service: "auth-service", endpoint: "POST /login" }
   */
  nameMap: Record<string, { service: string; endpoint: string }>;

  /**
   * Static replica counts per service (k6 doesn't capture replica counts).
   * If omitted, defaults to 1.
   */
  replicaCounts?: Record<string, number>;
}

interface K6RawRow {
  metricName: string;
  timestamp: Date;
  metricValue: number;
  name: string;      // k6 request name tag
  status: string;    // HTTP status code
}

interface SlotAccumulator {
  service: string;
  endpoint: string;
  minuteTimestamp: string;
  durations: number[];    // http_req_duration samples (ms)
  reqCount: number;       // total http_reqs count in this slot
  failedCount: number;    // http_req_failed count
  replicaCount: number;
}

export class K6CsvConverter {
  /**
   * @param k6CsvText   - Raw text from k6 `--out csv` output
   * @param config      - Mapping from k6 request names to service/endpoint labels
   * @returns           - MicroViSim standard CSV string
   */
  convert(k6CsvText: string, config: K6ServiceEndpointConfig): string {
    const rows = this.parseK6Csv(k6CsvText);
    const slots = this.aggregateIntoSlots(rows, config);
    return this.renderStandardCsv(slots);
  }

  // ─── K6 CSV Parsing ────────────────────────────────────────────────────────

  private parseK6Csv(csvText: string): K6RawRow[] {
    const lines = csvText
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.length > 0);

    if (lines.length < 2) return [];

    // k6 --out csv is comma-delimited, but accepting tab-delimited exports
    // makes files that were opened/saved by spreadsheet tools usable too.
    const delimiter = lines[0].includes("\t") ? "\t" : ",";
    const header = parseCsvLine(lines[0].replace(/^\uFEFF/, ""), delimiter).map(h => h.trim().toLowerCase());

    const idx = {
      metricName:  header.indexOf("metric_name"),
      timestamp:   header.indexOf("timestamp"),
      metricValue: header.indexOf("metric_value"),
      name:        header.indexOf("name"),
      status:      header.indexOf("status"),
    };

    const missing = Object.entries(idx)
      .filter(([, v]) => v === -1)
      .map(([k]) => k);

    if (missing.length > 0) {
      throw new Error(`k6 CSV is missing expected columns: ${missing.join(", ")}`);
    }

    const result: K6RawRow[] = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i], delimiter);
      if (cols.length <= Math.max(...Object.values(idx))) continue;

      const metricName = cols[idx.metricName]?.trim();
      if (!["http_req_duration", "http_reqs", "http_req_failed"].includes(metricName)) continue;

      const tsRaw = cols[idx.timestamp]?.trim();
      const ts = new Date(
        // k6 timestamps are Unix seconds (float) or ISO strings
        isNaN(Number(tsRaw)) ? tsRaw : Number(tsRaw) * 1000
      );
      if (isNaN(ts.getTime())) continue;

      // A malformed metric_value would otherwise silently poison every downstream
      // sum/median (NaN propagates through += and Math.max/percentile unnoticed).
      const metricValue = parseFloat(cols[idx.metricValue] ?? "0");
      if (isNaN(metricValue)) continue;

      result.push({
        metricName,
        timestamp: ts,
        metricValue,
        name:      cols[idx.name]?.trim() ?? "",
        status:    cols[idx.status]?.trim() ?? "",
      });
    }

    return result;
  }

  private aggregateIntoSlots(
    rows: K6RawRow[],
    config: K6ServiceEndpointConfig,
  ): SlotAccumulator[] {
    const slotMap = new Map<string, SlotAccumulator>();

    for (const row of rows) {
      const mapped = config.nameMap[row.name];
      if (!mapped) continue; // skip unmapped request names

      const { service, endpoint } = mapped;
      const minuteTimestamp = this.truncateToMinute(row.timestamp);
      const key = `${minuteTimestamp}::${service}::${endpoint}`;

      if (!slotMap.has(key)) {
        slotMap.set(key, {
          service,
          endpoint,
          minuteTimestamp,
          durations:    [],
          reqCount:     0,
          failedCount:  0,
          replicaCount: config.replicaCounts?.[service] ?? 1,
        });
      }

      const slot = slotMap.get(key)!;

      switch (row.metricName) {
        case "http_req_duration":
          slot.durations.push(row.metricValue);
          break;
        case "http_reqs":
          slot.reqCount += row.metricValue;
          break;
        case "http_req_failed":
          slot.failedCount += row.metricValue;
          break;
      }
    }

    return Array.from(slotMap.values())
      .sort((a, b) => a.minuteTimestamp.localeCompare(b.minuteTimestamp));
  }

  private renderStandardCsv(slots: SlotAccumulator[]): string {
    const header = "timestamp,service,endpoint,rps,p50_ms,p95_ms,error_rate,replica_count";
    const dataRows = slots.map(slot => {
      const p50 = this.percentile(slot.durations, 50);
      const p95 = this.percentile(slot.durations, 95);
      // RPS = requests in this 1-minute slot / 60
      const rps = slot.reqCount / 60;
      const errorRate = slot.reqCount > 0
        ? slot.failedCount / slot.reqCount
        : 0;

      return [
        slot.minuteTimestamp,
        slot.service,
        slot.endpoint,
        rps.toFixed(3),
        p50.toFixed(1),
        p95.toFixed(1),
        errorRate.toFixed(6),
        slot.replicaCount,
      ].join(",");
    });

    return [header, ...dataRows].join("\n");
  }

  private truncateToMinute(ts: Date): string {
    const d = new Date(ts);
    d.setUTCSeconds(0, 0);
    return d.toISOString();
  }

  private percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(idx);
    const upper = Math.ceil(idx);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
  }
}
