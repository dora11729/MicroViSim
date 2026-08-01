/**
 * Regression tests for the drift UNIT trap.
 *
 * MetricsExtractor regresses p50 over the slot INDEX, so its raw slope is ms per SLOT.
 * driftDetectionThresholdMs is documented in ms/HOUR. If the raw per-slot slope were
 * thresholded directly, drift detection would silently depend on how fast the CSV was
 * sampled: a genuine 120 ms/hour drift is only a 2 ms/slot slope at 1-minute resolution,
 * landing right on the default 2.0 threshold instead of 60x above it.
 */

import { MetricsExtractor } from "../../src/MicroViSim-simulator/classes/SimConfigConverter/MetricsExtractor";
import { ParameterDeriver } from "../../src/MicroViSim-simulator/classes/SimConfigConverter/ParameterDeriver";
import { buildDriftCsv, buildEvenCsv } from "./csvFixtures";

const KEY = "auth-service::POST /login";

function deriveFor(csv: string) {
  const metrics = new MetricsExtractor().extract(csv);
  const derived = new ParameterDeriver().derive(metrics);
  return { observed: metrics.get(KEY)!, derived: derived.get(KEY)! };
}

describe("drift detection is invariant to CSV sampling rate", () => {
  const MS_PER_HOUR = 120;
  // 12 hours so even 1-hour sampling clears MIN_SLOTS_FOR_STATS (13 slots), while the
  // finer rates get capped down to MAX_SLOTS — which is itself part of what's under test:
  // the normalised ms/hour slope must survive the cap.
  const SPAN_SECONDS = 12 * 3600;

  const cases = [
    { label: "1-minute sampling", intervalSec: 60 },
    { label: "5-minute sampling", intervalSec: 300 },
    { label: "1-hour sampling", intervalSec: 3600 },
  ];

  for (const { label, intervalSec } of cases) {
    it(`detects the same ${MS_PER_HOUR} ms/hour drift at ${label}`, () => {
      const csv = buildDriftCsv({ msPerHour: MS_PER_HOUR, intervalSec, spanSeconds: SPAN_SECONDS });
      const { derived } = deriveFor(csv);

      expect(derived.hasDrift).toBe(true);
      // The normalised slope is the sampling-rate-independent quantity.
      expect(derived.diagnostics.rawDriftSlopeMsPerHour).toBeCloseTo(MS_PER_HOUR, 0);
    });
  }

  it("reports the same ms/hour slope across all three sampling rates", () => {
    const slopes = cases.map(({ intervalSec }) => {
      const csv = buildDriftCsv({ msPerHour: MS_PER_HOUR, intervalSec, spanSeconds: SPAN_SECONDS });
      return deriveFor(csv).derived.diagnostics.rawDriftSlopeMsPerHour;
    });

    for (const s of slopes) expect(s).toBeCloseTo(slopes[0], 0);
  });

  it("keeps driftRatePerSlot in calibration units (scales with slot duration)", () => {
    const perMinute = deriveFor(
      buildDriftCsv({ msPerHour: MS_PER_HOUR, intervalSec: 60, spanSeconds: SPAN_SECONDS }));
    const perHour = deriveFor(
      buildDriftCsv({ msPerHour: MS_PER_HOUR, intervalSec: 3600, spanSeconds: SPAN_SECONDS }));

    // Same physical drift, but expressed per slot: 1-minute slots accumulate 1/60th as
    // much per slot as 1-hour slots. advanceDrift runs once per slot, so this is the
    // value the calibration simulation must use.
    const ratio = perHour.derived.driftRatePerSlot / perMinute.derived.driftRatePerSlot;
    expect(ratio).toBeCloseTo(
      perHour.observed.slotDurationSeconds / perMinute.observed.slotDurationSeconds, 0);
  });

  it("does not flag a flat series as drift at any sampling rate", () => {
    for (const { intervalSec } of cases) {
      const csv = buildDriftCsv({ msPerHour: 0, intervalSec, spanSeconds: SPAN_SECONDS });
      const { derived } = deriveFor(csv);
      expect(derived.hasDrift).toBe(false);
      expect(derived.driftRatePerSlot).toBe(0);
    }
  });

  it("does not flag improving latency as drift (gradualDrift cannot model it)", () => {
    const csv = buildDriftCsv({
      msPerHour: -120, intervalSec: 60, spanSeconds: SPAN_SECONDS, baseP50: 800,
    });
    const { derived } = deriveFor(csv);

    expect(derived.hasDrift).toBe(false);
    expect(derived.driftRatePerSlot).toBe(0);
    expect(derived.diagnostics.driftConfidence).toBe("none");
  });

  it("downgrades confidence to weak when the whole span is under an hour", () => {
    // Steep drift, but measured over 15 minutes — extrapolating it to an hourly rate
    // that the simulator replays for 24-168 hours is not strongly evidenced.
    const csv = buildDriftCsv({ msPerHour: 600, intervalSec: 60, spanSeconds: 15 * 60 });
    const { derived } = deriveFor(csv);

    expect(derived.hasDrift).toBe(true);
    expect(derived.diagnostics.driftConfidence).toBe("weak");
  });

  it("suppresses drift inference when there are too few slots", () => {
    const csv = buildEvenCsv(3, 60, i => ({ p50Ms: 100 + i * 50 }));
    const { derived } = deriveFor(csv);

    expect(derived.diagnostics.insufficientSlots).toBe(true);
    expect(derived.hasDrift).toBe(false);
    expect(derived.diagnostics.rawDriftSlopeMsPerHour).toBe(0);
  });
});
