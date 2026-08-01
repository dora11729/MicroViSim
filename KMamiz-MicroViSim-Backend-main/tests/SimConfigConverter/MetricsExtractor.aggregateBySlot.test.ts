import { MetricsExtractor } from "../../src/MicroViSim-simulator/classes/SimConfigConverter/MetricsExtractor";
import { buildCsv, buildEvenCsv, SampleSpec } from "./csvFixtures";

const KEY = "auth-service::POST /login";

describe("MetricsExtractor slot bucketing", () => {
  it("produces one slot per minute with no gaps for a contiguous 15-minute CSV", () => {
    const csv = buildEvenCsv(15, 60);
    const m = new MetricsExtractor().extract(csv).get(KEY)!;

    expect(m.slotStats).toHaveLength(15);
    expect(m.slotStats.every(s => !s.isGap)).toBe(true);
    expect(m.slotStats.map(s => s.slotIndex)).toEqual([...Array(15).keys()]);
  });

  it("marks a mid-test hole as gap slots with carried-forward latency and zero rps", () => {
    // Minutes 0-4 present, 5-7 missing, 8-11 present.
    const samples: SampleSpec[] = [];
    for (const i of [0, 1, 2, 3, 4, 8, 9, 10, 11]) {
      samples.push({ offsetSeconds: i * 60, rps: 10, p50Ms: 100, p95Ms: 150, errorRate: 0.01 });
    }
    const m = new MetricsExtractor().extract(buildCsv(samples)).get(KEY)!;

    expect(m.slotStats).toHaveLength(12);

    const gaps = m.slotStats.filter(s => s.isGap);
    expect(gaps.map(s => s.slotIndex)).toEqual([5, 6, 7]);

    for (const g of gaps) {
      expect(g.rps).toBe(0);
      expect(g.errorRate).toBe(0);
      // Carried forward from slot 4, not zeroed — a fake cliff to 0 would read as
      // enormous negative drift to the OLS regression.
      expect(g.p50Ms).toBe(100);
      expect(g.p95Ms).toBe(150);
    }
  });

  it("never puts a gap at the first or last slot (per-endpoint windowing)", () => {
    // Two endpoints, one of which only appears at the very end of the window.
    const early = buildEvenCsv(20, 60, () => ({}), "svc-a", "GET /a");
    const lateRows = [5, 6, 7, 8, 9, 10].map(i =>
      `${new Date(Date.UTC(2024, 0, 1) + (i + 60) * 60 * 1000).toISOString()},svc-b,GET /b,5,80,120,0,1`);
    const csv = [early, ...lateRows].join("\n");

    const metrics = new MetricsExtractor().extract(csv);
    const late = metrics.get("svc-b::GET /b")!;

    // Windowed to its own 6 samples, not padded out to cover svc-a's window.
    expect(late.slotStats).toHaveLength(6);
    expect(late.slotStats[0].isGap).toBe(false);
    expect(late.slotStats[late.slotStats.length - 1].isGap).toBe(false);
  });

  it("keeps medianErrorRate free of synthetic gap zeros", () => {
    // Every real sample has a 2% error rate; three slots are missing entirely.
    const samples: SampleSpec[] = [];
    for (const i of [0, 1, 2, 3, 4, 8, 9, 10, 11]) {
      samples.push({ offsetSeconds: i * 60, rps: 10, errorRate: 0.02 });
    }
    const m = new MetricsExtractor().extract(buildCsv(samples)).get(KEY)!;

    expect(m.slotStats.some(s => s.isGap)).toBe(true);
    // Would be 0.02 only if the synthetic zeros are excluded.
    expect(m.medianErrorRate).toBeCloseTo(0.02, 6);
  });

  it("computes the baseline from low-load, non-gap slots only", () => {
    // Low load (rps 2) at 50ms, high load (rps 40) at 500ms.
    const samples: SampleSpec[] = [];
    for (let i = 0; i < 10; i++) {
      const busy = i >= 5;
      samples.push({
        offsetSeconds: i * 60,
        rps: busy ? 40 : 2,
        p50Ms: busy ? 500 : 50,
        p95Ms: busy ? 700 : 70,
      });
    }
    const m = new MetricsExtractor().extract(buildCsv(samples)).get(KEY)!;

    expect(m.peakRps).toBe(40);
    expect(m.baselineP50Ms).toBe(50);
    expect(m.baselineJitterMs).toBe(20);
  });
});
