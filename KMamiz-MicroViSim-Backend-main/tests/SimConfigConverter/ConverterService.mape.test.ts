/**
 * MAPE comparability mask.
 *
 * Before the mask existed, gap slots compared a carried-forward observation against the
 * simulator's structural 0 and charged 100% each, which pinned the latency MAPE near
 * 95.8% for any sub-24h CSV no matter what the candidate parameters were.
 */

import { MetricsExtractor } from "../../src/MicroViSim-simulator/classes/SimConfigConverter/MetricsExtractor";
import { ParameterDeriver } from "../../src/MicroViSim-simulator/classes/SimConfigConverter/ParameterDeriver";
import {
  ConverterService,
  ISimulatorRunner,
  SimulatorRunParams,
  SimulatorRunResult,
} from "../../src/MicroViSim-simulator/classes/SimConfigConverter/ConverterService";
import { buildCsv, SampleSpec } from "./csvFixtures";

const KEY = "auth-service::POST /login";

/** A simulator that reproduces the observed p50 exactly wherever traffic exists. */
class PerfectRunner implements ISimulatorRunner {
  constructor(private readonly observedP50: number[], private readonly observedErr: number[]) {}

  runEndpoint(params: SimulatorRunParams): SimulatorRunResult {
    const n = params.slotRps.length;
    const p50BySlot: number[] = [];
    const errorRateBySlot: number[] = [];
    const rpsBySlot: number[] = [];
    const simulatedRequestCountBySlot: number[] = [];
    const simulatedErrorCountBySlot: number[] = [];

    for (let i = 0; i < n; i++) {
      const rps = params.slotRps[i] ?? 0;
      const requests = rps > 0 ? Math.max(1, Math.round(rps * params.slotDurationSeconds)) : 0;
      // No traffic → the propagator emits no stats and p50 is 0, exactly like the real one.
      p50BySlot.push(requests > 0 ? this.observedP50[i] : 0);
      errorRateBySlot.push(requests > 0 ? this.observedErr[i] : 0);
      rpsBySlot.push(rps);
      simulatedRequestCountBySlot.push(requests);
      simulatedErrorCountBySlot.push(Math.round(requests * (this.observedErr[i] ?? 0)));
    }

    return {
      p50BySlot, errorRateBySlot, rpsBySlot,
      simulatedRequestCountBySlot, simulatedErrorCountBySlot,
    };
  }
}

function pipeline(csv: string, runnerFor: (p50: number[], err: number[]) => ISimulatorRunner) {
  const metrics = new MetricsExtractor().extract(csv);
  const derived = new ParameterDeriver().derive(metrics);
  const observed = metrics.get(KEY)!;

  const runner = runnerFor(
    observed.slotStats.map(s => s.p50Ms),
    observed.slotStats.map(s => s.errorRate),
  );
  const result = new ConverterService(runner, { mapeSamplesPerCandidate: 1 })
    .convert(metrics, derived);

  return { observed, config: result.convertedEndpoints.get(KEY)! };
}

describe("ConverterService MAPE masking", () => {
  it("scores a perfectly-matching candidate near zero even when the CSV has gaps", () => {
    // Minutes 0-4 and 8-11 present; 5-7 missing.
    const samples: SampleSpec[] = [];
    for (const i of [0, 1, 2, 3, 4, 8, 9, 10, 11]) {
      samples.push({ offsetSeconds: i * 60, rps: 10, p50Ms: 100, p95Ms: 140, errorRate: 0.01 });
    }
    const { observed, config } = pipeline(buildCsv(samples), (p50, err) => new PerfectRunner(p50, err));

    expect(observed.slotStats.filter(s => s.isGap)).toHaveLength(3);
    // The three gap slots must not each contribute a 100% error.
    expect(config.mape.latency).toBeLessThan(1);
    expect(config.mape.comparedSlotCount).toBe(9);
  });

  it("reports comparedSlotCount matching the number of real, simulated slots", () => {
    const samples: SampleSpec[] = [];
    for (let i = 0; i < 10; i++) {
      // Slots 3 and 7 are genuinely idle (present in the CSV, but zero traffic).
      const idle = i === 3 || i === 7;
      samples.push({ offsetSeconds: i * 60, rps: idle ? 0 : 10, p50Ms: 100, p95Ms: 140 });
    }
    const { config } = pipeline(buildCsv(samples), (p50, err) => new PerfectRunner(p50, err));

    // Idle slots have no simulated requests, so they are not comparable.
    expect(config.mape.comparedSlotCount).toBe(8);
  });

  it("keeps weighted consistent with its components", () => {
    const samples: SampleSpec[] = [];
    for (let i = 0; i < 10; i++) {
      samples.push({ offsetSeconds: i * 60, rps: 10, p50Ms: 100, p95Ms: 140, errorRate: 0.01 });
    }
    const { config } = pipeline(buildCsv(samples), (p50, err) => new PerfectRunner(p50, err));

    const expected =
      0.5 * config.mape.latency + 0.3 * config.mape.errorRate + 0.2 * config.mape.rps;
    expect(config.mape.weighted).toBeCloseTo(expected, 6);
  });

  it("excludes slots where every simulated request errored (no 200 latency sample)", () => {
    const samples: SampleSpec[] = [];
    for (let i = 0; i < 10; i++) {
      samples.push({ offsetSeconds: i * 60, rps: 10, p50Ms: 100, p95Ms: 140 });
    }

    // A runner that yields no successful-latency sample for slots 2 and 5.
    class PartialRunner implements ISimulatorRunner {
      runEndpoint(params: SimulatorRunParams): SimulatorRunResult {
        const n = params.slotRps.length;
        const mk = (f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));
        return {
          p50BySlot: mk(i => (i === 2 || i === 5 ? 0 : 100)),
          errorRateBySlot: mk(() => 0),
          rpsBySlot: mk(i => params.slotRps[i]),
          simulatedRequestCountBySlot: mk(() => 600),
          simulatedErrorCountBySlot: mk(() => 0),
        };
      }
    }

    const metrics = new MetricsExtractor().extract(buildCsv(samples));
    const derived = new ParameterDeriver().derive(metrics);
    const result = new ConverterService(new PartialRunner(), { mapeSamplesPerCandidate: 1 })
      .convert(metrics, derived);
    const config = result.convertedEndpoints.get(KEY)!;

    expect(config.mape.comparedSlotCount).toBe(8);
    expect(config.mape.latency).toBeLessThan(1);
  });
});
