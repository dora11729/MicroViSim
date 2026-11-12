import MinuteForecastSelector from "../../src/MicroViSim-simulator/classes/LoadSimulation/MinuteForecastSelector";

const selector = new MinuteForecastSelector();

describe("MinuteForecastSelector", () => {
  it("starts with linearInput while there is nothing to compare", () => {
    const { chosen } = selector.select([5, 5], { linearInput: [null, 1], rectify: [null, 5] });
    expect(chosen).toEqual([null, "linearInput"]);
  });

  it("picks the strategy that was closer over the past hours", () => {
    const { shares, chosen } = selector.select(
      [5, 5, 5, 5],
      { linearInput: [null, 1, 1, 10], rectify: [null, 5, 4, 20] }
    );
    expect(chosen).toEqual([null, "linearInput", "rectify", "rectify"]);
    expect(shares).toEqual([null, 1, 4, 20]);
  });

  it("keeps linearInput on a tie", () => {
    const { chosen } = selector.select([5, 5, 5], { linearInput: [null, 4, 0], rectify: [null, 6, 0] });
    expect(chosen[2]).toBe("linearInput");
  });

  it("never looks at the hour it forecasts", () => {
    const forecasts = { linearInput: [null, 1, 1], rectify: [null, 5, 9] };
    expect(selector.select([5, 5, 1], forecasts).chosen[2])
      .toBe(selector.select([5, 5, 9], forecasts).chosen[2]);
  });

  it("forgets hours older than the last 24", () => {
    // Hours 1..30: linearInput exact, rectify off by 10. Hours 31..54: linearInput off by
    // 2, rectify exact. Over all of it linearInput is closer; over the last 24 hours, rectify.
    const observed = Array(56).fill(5);
    const linearInput = [null, ...Array(30).fill(5), ...Array(24).fill(7), 0];
    const rectify = [null, ...Array(30).fill(15), ...Array(24).fill(5), 0];
    expect(selector.select(observed, { linearInput, rectify }).chosen[55]).toBe("rectify");
  });

  it("falls back to the other strategy when the picked one has no forecast", () => {
    const { shares, chosen } = selector.select([5, 5], { linearInput: [null, null], rectify: [null, 3] });
    expect(chosen).toEqual([null, "rectify"]);
    expect(shares).toEqual([null, 3]);
  });
});
