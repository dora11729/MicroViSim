/**
 * Emit-time unit conversion: per-calibration-slot → per-hour.
 *
 * Calibration runs at the CSV's own resolution, but the emitted YAML is replayed by a
 * simulator whose slot is hardcoded to one hour, so driftRate/recoveryRate/spikeDuration/
 * spikeProbability all have to be translated on the way out.
 */

import { MetricsExtractor } from "../../src/MicroViSim-simulator/classes/SimConfigConverter/MetricsExtractor";
import { ParameterDeriver } from "../../src/MicroViSim-simulator/classes/SimConfigConverter/ParameterDeriver";
import {
  ConverterService,
  ISimulatorRunner,
  SimulatorRunParams,
  SimulatorRunResult,
} from "../../src/MicroViSim-simulator/classes/SimConfigConverter/ConverterService";
import { buildCsv, buildDriftCsv, SampleSpec } from "./csvFixtures";

const KEY = "auth-service::POST /login";

/** Deterministic stand-in — these tests are about units, not fit quality. */
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
  return {
    observed: metrics.get(KEY)!,
    derived: derived.get(KEY)!,
    config: result.convertedEndpoints.get(KEY)!,
  };
}

/** Duty cycle implied by a (probability, duration) pair under advanceSpike's process. */
function dutyCycleOf(p: number, d: number): number {
  const pd = p * d;
  return pd / (1 + pd);
}

describe("emitted drift units", () => {
  it("scales driftRate from ms/slot to ms/hour", () => {
    const csv = buildDriftCsv({ msPerHour: 120, intervalSec: 60, spanSeconds: 12 * 3600 });
    const { observed, derived, config } = convert(csv);

    const drift = config.delays.find(d => d.type === "gradualDrift");
    expect(drift?.type).toBe("gradualDrift");
    if (drift?.type !== "gradualDrift") throw new Error("expected gradualDrift");

    const slotsPerHour = 3600 / observed.slotDurationSeconds;
    expect(drift.driftRate).toBeCloseTo(derived.driftRatePerSlot * slotsPerHour, 1);
    // And it should land on the physical rate the fixture encodes.
    expect(drift.driftRate).toBeCloseTo(120, 0);
  });

  it("emits the same per-hour driftRate regardless of sampling rate", () => {
    const rates = [60, 300, 3600].map(intervalSec => {
      const csv = buildDriftCsv({ msPerHour: 120, intervalSec, spanSeconds: 12 * 3600 });
      const drift = convert(csv).config.delays.find(d => d.type === "gradualDrift");
      if (drift?.type !== "gradualDrift") throw new Error("expected gradualDrift");
      return drift.driftRate;
    });

    for (const r of rates) expect(r).toBeCloseTo(rates[0], 0);
  });

  it("is an identity conversion when the CSV is already hourly", () => {
    const csv = buildDriftCsv({ msPerHour: 120, intervalSec: 3600, spanSeconds: 12 * 3600 });
    const { observed, derived, config } = convert(csv);

    expect(observed.slotDurationSeconds).toBe(3600);
    const drift = config.delays.find(d => d.type === "gradualDrift");
    if (drift?.type !== "gradualDrift") throw new Error("expected gradualDrift");
    expect(drift.driftRate).toBeCloseTo(derived.driftRatePerSlot, 2);
  });
});

describe("emitted spike units", () => {
  /** ~20% of minutes spiking, in runs of 2. */
  function spikyCsv(): string {
    const samples: SampleSpec[] = [];
    for (let i = 0; i < 60; i++) {
      const spiking = i % 10 === 0 || i % 10 === 1;
      samples.push({
        offsetSeconds: i * 60,
        rps: 10,
        p50Ms: 100,
        p95Ms: spiking ? 500 : 130,
        errorRate: 0,
      });
    }
    return buildCsv(samples);
  }

  it("floors spikeDuration at one hour and preserves the duty cycle", () => {
    const { config } = convert(spikyCsv());

    const spike = config.delays.find(d => d.type === "spike");
    expect(spike?.type).toBe("spike");
    if (spike?.type !== "spike") throw new Error("expected spike");

    // A 2-minute spike cannot be represented below one hour.
    expect(spike.spikeDuration).toBe(1);
    expect(spike.spikeProbability).toBeGreaterThanOrEqual(0.01);
    expect(spike.spikeProbability).toBeLessThanOrEqual(1);

    // The catastrophic alternative (1-(1-p)^60) would push this to ~1.0, turning a
    // 20%-of-the-time spike into an always-on one.
    expect(spike.spikeProbability).toBeLessThan(0.5);
  });

  it("keeps the emitted duty cycle close to the calibrated one", () => {
    const { config } = convert(spikyCsv());
    const spike = config.delays.find(d => d.type === "spike");
    if (spike?.type !== "spike") throw new Error("expected spike");

    const emitted = dutyCycleOf(spike.spikeProbability, spike.spikeDuration);
    // Observed: 2 spiking minutes out of every 10 → 20%.
    expect(emitted).toBeGreaterThan(0.1);
    expect(emitted).toBeLessThan(0.32);
  });

  it("explains the conversion in selectionReasons", () => {
    const { config } = convert(spikyCsv());
    expect(config.selectionReasons.spike).toMatch(/duty cycle/);
  });
});

describe("slotModel reporting", () => {
  it("records slot duration, count and span", () => {
    const csv = buildDriftCsv({ msPerHour: 120, intervalSec: 60, spanSeconds: 30 * 60 });
    const { config } = convert(csv);

    expect(config.slotModel.slotDurationSeconds).toBe(60);
    expect(config.slotModel.slotCount).toBe(31);
    expect(config.slotModel.observedSpanSeconds).toBe(30 * 60);
  });

  it("warns when drift is extrapolated from a sub-hour window", () => {
    const csv = buildDriftCsv({ msPerHour: 600, intervalSec: 60, spanSeconds: 15 * 60 });
    const { config } = convert(csv);

    expect(config.slotModel.notes.some(n => /drift measured over only/.test(n))).toBe(true);
    expect(config.slotModel.notes.some(n => /maxLatencyMs/.test(n))).toBe(true);
  });
});
