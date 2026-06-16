import { RealtimeDataList } from "../src/classes/RealtimeDataList";
import { MockBaseCrlData1, MockBaseRlData1, Namespace } from "./MockData";

describe("RealtimeDataList", () => {
  it("gets containing namespaces", () => {
    const rlData = new RealtimeDataList(MockBaseRlData1);
    expect([...rlData.getContainingNamespaces()]).toEqual([Namespace]);
  });

  it("converts to combined realtime data", () => {
    const rlData = new RealtimeDataList(MockBaseRlData1);
    const result = rlData.toCombinedRealtimeData().toJSON();

    expect(result[0].latency.p95).toBeCloseTo(MockBaseCrlData1[0].latency.p95, 10);
    result[0].latency.p95 = MockBaseCrlData1[0].latency.p95;
    expect(result).toEqual(MockBaseCrlData1);
  });
});
