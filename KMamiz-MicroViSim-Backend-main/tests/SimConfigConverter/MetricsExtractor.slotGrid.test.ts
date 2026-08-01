import { MetricsExtractor } from "../../src/MicroViSim-simulator/classes/SimConfigConverter/MetricsExtractor";
import { buildEvenCsv } from "./csvFixtures";

const KEY = "auth-service::POST /login";

describe("MetricsExtractor slot grid selection", () => {
  it("uses the native 1-minute sampling interval for a 15-minute CSV", () => {
    // 15 one-minute samples — the canonical k6 output shape.
    const csv = buildEvenCsv(15, 60);
    const metrics = new MetricsExtractor().extract(csv);
    const m = metrics.get(KEY)!;

    expect(m.slotDurationSeconds).toBe(60);
    expect(m.nativeIntervalSeconds).toBe(60);
    // 14 minutes of span at 60s per slot → 15 slots, NOT 24.
    expect(m.slotStats).toHaveLength(15);
  });

  it("coarsens a 15-second interval up to the 1-minute floor when slots remain", () => {
    // 2 hours at 15s = 481 samples; coarsening to 60s still leaves ~120 slots.
    const csv = buildEvenCsv(481, 15);
    const m = new MetricsExtractor().extract(csv).get(KEY)!;

    expect(m.nativeIntervalSeconds).toBe(15);
    expect(m.slotDurationSeconds).toBeGreaterThanOrEqual(60);
    expect(m.slotGridReason).toMatch(/1-minute floor|capped/);
  });

  it("keeps a sub-minute interval when coarsening would drop below MIN_SLOTS_FOR_STATS", () => {
    // 10 samples 5s apart = 45s span. Coarsening to 60s would leave 1 slot.
    const csv = buildEvenCsv(10, 5);
    const m = new MetricsExtractor().extract(csv).get(KEY)!;

    expect(m.nativeIntervalSeconds).toBe(5);
    expect(m.slotDurationSeconds).toBe(5);
    expect(m.slotStats.length).toBeGreaterThanOrEqual(MetricsExtractor.MIN_SLOTS_FOR_STATS);
    expect(m.slotGridReason).toMatch(/below the 1-minute floor/);
  });

  it("caps the slot count for a multi-day export instead of producing thousands", () => {
    // 3 days at 5-minute sampling = 865 samples. Naively that's 865 slots.
    const csv = buildEvenCsv(865, 300);
    const m = new MetricsExtractor().extract(csv).get(KEY)!;

    expect(m.slotStats.length).toBeLessThanOrEqual(MetricsExtractor.MAX_SLOTS);
    expect(m.slotGridReason).toMatch(/capped/);
    // Slot duration must stay a whole multiple of the native interval so each slot
    // holds the same number of source rows.
    expect(m.slotDurationSeconds % m.nativeIntervalSeconds).toBe(0);
  });

  it("honours an explicit slot duration override", () => {
    const csv = buildEvenCsv(60, 60);
    const m = new MetricsExtractor().extract(csv, 0.5, 300).get(KEY)!;

    expect(m.slotDurationSeconds).toBe(300);
    expect(m.slotGridReason).toMatch(/explicit/);
  });

  it("derives the interval from the median gap, not one outlier gap", () => {
    // Mostly 60s spacing with a single 10-minute hole partway through.
    const offsets = [0, 60, 120, 180, 240, 840, 900, 960, 1020, 1080];
    const csv = [
      "timestamp,service,endpoint,rps,p50_ms,p95_ms,error_rate,replica_count",
      ...offsets.map(o =>
        `${new Date(Date.UTC(2024, 0, 1) + o * 1000).toISOString()},auth-service,POST /login,10,100,150,0,2`),
    ].join("\n");

    const m = new MetricsExtractor().extract(csv).get(KEY)!;
    expect(m.nativeIntervalSeconds).toBe(60);
  });
});
