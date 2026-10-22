import LoadSimulationHandler from "../../src/MicroViSim-simulator/classes/LoadSimulation/LoadSimulationHandler";
import SimulationRandom from "../../src/MicroViSim-simulator/classes/SimulationRandom";
import {
  loadSimulationConfigSchema,
  TSimulationTrafficPattern,
} from "../../src/MicroViSim-simulator/entities/TSimConfigLoadSimulation";

const Seed = 1234;
const SlotsPerDay = 24;
const DailyRequestCount = 240000;

const accepts = (trafficPattern: object) => loadSimulationConfigSchema.safeParse({ trafficPattern }).success;

function mockPattern(pattern: Partial<TSimulationTrafficPattern> = {}): TSimulationTrafficPattern {
  return { shape: "flat", peakHour: 14, secondPeakHour: 19, peakRatio: 3, ...pattern };
}

// Reseeds first so the ±20% jitter is identical on every run.
function distribute(
  pattern: TSimulationTrafficPattern,
  simulationDurationInDays = 1
): number[][] {
  SimulationRandom.getInstance().reset(Seed);
  return (LoadSimulationHandler.getInstance() as any).distributeRequestCountsForSimulationDuration({
    expectedExternalDailyRequestCount: DailyRequestCount,
    simulationDurationInDays,
    timeSlotCountPerDay: SlotsPerDay,
    trafficPattern: pattern,
  });
}

describe("LoadSimulationHandler traffic pattern", () => {
  it("spreads a flat day evenly apart from the jitter", () => {
    const [day] = distribute(mockPattern());
    expect(Math.max(...day) / Math.min(...day)).toBeLessThan(2);
  });

  it("preserves the daily total whatever the shape", () => {
    const sum = (day: number[]) => day.reduce((a, b) => a + b, 0);
    expect(sum(distribute(mockPattern())[0])).toBe(DailyRequestCount);
    expect(sum(distribute(mockPattern({ shape: "unimodal" }))[0])).toBe(DailyRequestCount);
  });

  it("makes the peak hour busier than its opposite", () => {
    const [day] = distribute(mockPattern({ shape: "unimodal", peakHour: 14, peakRatio: 3 }));
    // 3x shape either side of ±20% jitter still leaves the two well apart.
    expect(day[14] / day[2]).toBeGreaterThan(2);
  });

  it("moves the busy period with peakHour", () => {
    // Neighbouring slots differ by ~1% of shape, far less than the jitter, so compare
    // slots half a day apart where the shape difference is the full peakRatio.
    const [early] = distribute(mockPattern({ shape: "unimodal", peakHour: 6 }));
    const [late] = distribute(mockPattern({ shape: "unimodal", peakHour: 18 }));
    expect(early[6]).toBeGreaterThan(early[18]);
    expect(late[18]).toBeGreaterThan(late[6]);
  });

  it("jitters a shaped profile less than a flat one", () => {
    // peakRatio 1 flattens the shape, so the two runs differ only in jitter amplitude,
    // and the shared seed means they draw the same underlying numbers.
    const spread = (day: number[]) => Math.max(...day) / Math.min(...day);
    const [flat] = distribute(mockPattern());
    const [shaped] = distribute(mockPattern({ shape: "unimodal", peakRatio: 1 }));
    expect(spread(shaped)).toBeLessThan(spread(flat));
  });

  it("treats peakRatio 1 as flat", () => {
    const [day] = distribute(mockPattern({ shape: "unimodal", peakRatio: 1 }));
    expect(Math.max(...day) / Math.min(...day)).toBeLessThan(2);
  });

  it("repeats the shape on every simulated day", () => {
    const days = distribute(mockPattern({ shape: "unimodal", peakHour: 14 }), 3);
    expect(days).toHaveLength(3);
    days.forEach(day => expect(day[14] / day[2]).toBeGreaterThan(2));
  });

  it("replays the same distribution for the same seed", () => {
    const pattern = mockPattern({ shape: "unimodal" });
    expect(distribute(pattern)).toEqual(distribute(pattern));
  });

  it("gives bimodal two busy periods with a dip between them", () => {
    const [day] = distribute(
      mockPattern({ shape: "bimodal", peakHour: 9, secondPeakHour: 19, peakRatio: 3 })
    );
    expect(day[9] / day[14]).toBeGreaterThan(1.5);
    expect(day[19] / day[14]).toBeGreaterThan(1.5);
    // The midday dip still outranks the small hours. Summed over a window because a
    // single slot's shape difference here is no bigger than the jitter.
    const window = (from: number) => day.slice(from, from + 3).reduce((a, b) => a + b, 0);
    expect(window(13) / window(1)).toBeGreaterThan(1.2);
  });

  it("keeps both bimodal peaks at a similar height", () => {
    const [day] = distribute(
      mockPattern({ shape: "bimodal", peakHour: 9, secondPeakHour: 19, peakRatio: 4 })
    );
    expect(day[9] / day[19]).toBeGreaterThan(0.6);
    expect(day[9] / day[19]).toBeLessThan(1.7);
  });

  it("preserves the daily total for bimodal", () => {
    const [day] = distribute(mockPattern({ shape: "bimodal", peakHour: 9, secondPeakHour: 19 }));
    expect(day.reduce((a, b) => a + b, 0)).toBe(DailyRequestCount);
  });

  it("still dips between closely spaced bimodal peaks", () => {
    const [day] = distribute(
      mockPattern({ shape: "bimodal", peakHour: 11, secondPeakHour: 16, peakRatio: 3 })
    );
    expect(day[11]).toBeGreaterThan(day[13]);
    expect(day[16]).toBeGreaterThan(day[13]);
  });

  it("follows custom hourly multipliers and leaves the other hours empty", () => {
    const [day] = distribute(mockPattern({ shape: "custom", hourlyMultipliers: [2, 1, 0, 1] }));
    // 2x either side of ±10% jitter.
    expect(day[0] / day[1]).toBeGreaterThan(1.6);
    expect(day[0] / day[1]).toBeLessThan(2.5);
    expect(day[2]).toBe(0);
    expect(day.slice(4)).toEqual(new Array(SlotsPerDay - 4).fill(0));
    expect(day.reduce((a, b) => a + b, 0)).toBe(DailyRequestCount);
  });
});

describe("trafficPattern schema", () => {
  it("accepts custom multipliers for up to a whole day", () => {
    expect(accepts({ shape: "custom", hourlyMultipliers: [1, 0.5] })).toBe(true);
    expect(accepts({ shape: "custom", hourlyMultipliers: new Array(24).fill(1) })).toBe(true);
  });

  it("rejects custom multipliers that are negative or too many", () => {
    expect(accepts({ shape: "custom", hourlyMultipliers: [1, -1] })).toBe(false);
    expect(accepts({ shape: "custom", hourlyMultipliers: new Array(25).fill(1) })).toBe(false);
  });
});
