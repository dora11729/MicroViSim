
// import Logger from "../../utils/Logger";
import { Cacheable } from "./Cacheable";
import { TTaggedSimulationYAML } from "../../entities/TTaggedSimulationYAML";


export class CTaggedSimulationYAML extends Cacheable<TTaggedSimulationYAML[]> {
  static readonly uniqueName = "TaggedSimulationYAML";
  private static readonly MAX_STORE_COUNT = 50; // The cache layer stores up to MAX_STORE_COUNT of the most recent simulated YAMLs

  constructor(initData?: TTaggedSimulationYAML[]) {
    super("TaggedSimulationYAML", initData);
    this.setInit(async () => { });
    this.setSync(async () => { });
  }

  getData(): TTaggedSimulationYAML[] {
    const data = super.getData();
    if (!data) return [];
    return data;
  }

  getDataByTag(tag?: string): TTaggedSimulationYAML | null {
    if (tag) {
      const existing = this.getData().filter((d) => d.tag === tag);
      if (existing.length > 0) {
        return existing[0]
      }
    }
    return null;
  }

//   getTagsWithTime(): { tag: string; time: number }[] {
//     const data = this.getData();
//     if (!data) return [];

//     const tags = data
//       .map((t) => ({ tag: t.tag, time: t.time! }));

//     return Array.from(
//       new Set(tags)
//     );
//   }

  add(taggedData: TTaggedSimulationYAML) {
    if (!taggedData.tag) {
      taggedData.tag = this.getDefaultTag()
    }
    const existing = this.getDataByTag(taggedData.tag);
    if (!existing) {
      taggedData.time = Date.now();
      const updated = [...this.getData(), taggedData]
        .sort((a, b) => b.time! - a.time!)
        .slice(0, CTaggedSimulationYAML.MAX_STORE_COUNT);

      this.setData(updated);
    }
  }

  delete(tag: string) {
    this.setData(
      this.getData().filter((d) => d.tag !== tag)
    );
  }

  getDefaultTag(prefix = "my_simulate_") {
    const now = new Date();
    const pad = (num: number) => num.toString().padStart(2, "0");

    const YYYY = now.getFullYear();
    const MM = pad(now.getMonth() + 1);
    const DD = pad(now.getDate());
    const HH = pad(now.getHours());
    const mm = pad(now.getMinutes());
    const ss = pad(now.getSeconds());

    return `${prefix}${YYYY}${MM}${DD}${HH}${mm}${ss}`;
  }
}
