import SimulationRandom from "../../src/MicroViSim-simulator/classes/SimulationRandom";

function draw(seed: number | undefined, count: number): number[] {
  const random = SimulationRandom.getInstance();
  random.reset(seed);
  return Array.from({ length: count }, () => random.next());
}

describe("SimulationRandom", () => {
  it("replays the same stream for the same seed", () => {
    expect(draw(42, 20)).toEqual(draw(42, 20));
  });

  it("produces a different stream for a different seed", () => {
    expect(draw(42, 20)).not.toEqual(draw(43, 20));
  });

  it("stays within the range of Math.random", () => {
    for (const value of draw(7, 500)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("reports the seed it used", () => {
    expect(SimulationRandom.getInstance().reset(123)).toBe(123);
  });

  it("picks a seed when none is given", () => {
    const random = SimulationRandom.getInstance();
    const seeds = new Set(Array.from({ length: 20 }, () => random.reset()));
    expect(seeds.size).toBeGreaterThan(1);
  });

  it("keeps drawing after a reseed instead of repeating the first value", () => {
    const values = draw(99, 50);
    expect(new Set(values).size).toBe(values.length);
  });
});
