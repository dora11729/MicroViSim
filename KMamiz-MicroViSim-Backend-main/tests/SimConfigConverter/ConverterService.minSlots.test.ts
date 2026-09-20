/**
 * Minimum-data behaviour, and the degeneracies that the fixed-24-slot bucketing used to
 * cause for any sub-24h CSV.
 */

import { MetricsExtractor } from "../../src/MicroViSim-simulator/classes/SimConfigConverter/MetricsExtractor";
import { ParameterDeriver } from "../../src/MicroViSim-simulator/classes/SimConfigConverter/ParameterDeriver";
import {
  ConverterService,
  ISimulatorRunner,
  SimulatorRunParams,
  SimulatorRunResult,
} from "../../src/MicroViSim-simulator/classes/SimConfigConverter/ConverterService";
import { buildCsv, buildEvenCsv, CSV_HEADER, SampleSpec } from "./csvFixtures";

const KEY = "auth-service::POST /login";

class FlatRunner implements ISimulatorRunner {
  runEndpoint(params: SimulatorRunParams): SimulatorRunResult {
    const n = params.slotRps.length;
    const mk = (f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));
    return {
      p50BySlot: mk(() => 100),
      errorRateBySlot: mk(() => 0),
      rpsBySlot: mk(i => params.slotRps[i] ?? 0),
      simulatedRequestCountBySlot: mk(() => 100),
      simulatedErrorCountBySlot: mk(() => 0),
    };
  }
}

function convert(csv: string) {
  const metrics = new MetricsExtractor().extract(csv);
  const derived = new ParameterDeriver().derive(metrics);
  const result = new ConverterService(new FlatRunner(), { mapeSamplesPerCandidate: 1 })
    .convert(metrics, derived);
  return result.convertedEndpoints.get(KEY)!;
}

describe("minimum-data guards", () => {
  it("degrades a 2-slot endpoint to a plain jitter delay with an explanation instead of throwing", () => {
    const config = convert(buildEvenCsv(2, 60));

    expect(config.selectedTypes).toEqual(["jitter"]);
    expect(config.selectionReasons.jitter).toMatch(/time slot/);
    expect(config.slotModel.notes.some(n => /pattern detection/.test(n))).toBe(true);
  });

  it("still derives latency, jitter, errorRate and capacity from the few samples", () => {
    const csv = buildCsv([
      { offsetSeconds: 0, rps: 20, p50Ms: 80, p95Ms: 120, errorRate: 0.05, replicaCount: 4 },
      { offsetSeconds: 60, rps: 20, p50Ms: 80, p95Ms: 120, errorRate: 0.05, replicaCount: 4 },
    ]);
    const config = convert(csv);

    expect(config.errorRatePercent).toBeCloseTo(5, 3);
    expect(config.capacityPerReplica).toBeCloseTo(5, 2); // 20 rps / 4 replicas
    const jitter = config.delays.find(d => d.type === "jitter");
    expect(jitter?.latencyMs).toBeGreaterThan(0);
  });

  it("throws when the CSV has no parseable data rows", () => {
    const csv = [CSV_HEADER, "not,a,valid,row,at,all,really,nope"].join("\n");
    expect(() => new MetricsExtractor().extract(csv)).toThrow(/no parseable data rows/);
  });

  it("throws when required columns are missing", () => {
    const csv = ["timestamp,service,endpoint", "2024-01-01T00:00:00Z,a,b"].join("\n");
    expect(() => new MetricsExtractor().extract(csv)).toThrow(/missing required columns/);
  });
});

describe("a short CSV no longer degenerates the whole pipeline", () => {
  /** 15 minutes with a genuine load↔latency correlation — the motivating case. */
  function correlatedCsv(): string {
    const samples: SampleSpec[] = [];
    for (let i = 0; i < 15; i++) {
      const rps = 5 + i * 3;                 // ramping load
      const p50 = 50 + rps * 4;              // latency tracks load
      samples.push({
        offsetSeconds: i * 60,
        rps,
        p50Ms: p50,
        p95Ms: p50 * 1.3,
        errorRate: 0.02,
        replicaCount: 2,
      });
    }
    return buildCsv(samples);
  }

  it("produces one slot per observed minute rather than 1 real + 23 synthetic", () => {
    const m = new MetricsExtractor().extract(correlatedCsv()).get(KEY)!;
    expect(m.slotStats).toHaveLength(15);
    expect(m.slotStats.every(s => !s.isGap)).toBe(true);
  });

  it("can now select loadDriven, which was unreachable before", () => {
    const config = convert(correlatedCsv());
    expect(config.selectedTypes).toContain("loadDriven");
    expect(config.selectionReasons.loadDriven).toMatch(/Pearson/);
  });

  it("reports a real median error rate instead of a synthetic 0", () => {
    const m = new MetricsExtractor().extract(correlatedCsv()).get(KEY)!;
    expect(m.medianErrorRate).toBeCloseTo(0.02, 6);
    expect(convert(correlatedCsv()).errorRatePercent).toBeCloseTo(2, 3);
  });

  it("compares every observed slot when scoring", () => {
    const config = convert(correlatedCsv());
    expect(config.mape.comparedSlotCount).toBe(15);
  });
});
