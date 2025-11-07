import Config from "../../Config";
import { TTaggedDiffData } from "../entities/comparator/TTaggedDiffData";
import { DataView } from "./DataView";

export default class ComparatorService {
  private static instance?: ComparatorService;
  static getInstance = () => this.instance || (this.instance = new this());
  private constructor() { }

  private readonly prefix = `${Config.apiPrefix}/comparator`;

  private subscribeToArray<T>(path: string, next: (data: T[]) => void) {
    return DataView.getInstance().subscribe<T[]>(path, (_, data) =>
      next(data || [])
    );
  }

  private async get<T>(path: string) {
    const res = await fetch(path);
    if (!res.ok) return null;
    return (await res.json()) as T;
  }

  async getDiffdataTags() {
    return (
      (await this.get<{ tag: string; time: number }[]>(
        `${this.prefix}/tags`
      )) || []
    );
  }

  async addTaggedDiffData(tag: string) {
    const res = await fetch(`${this.prefix}/diffData`, {
      method: "POST",
      body: JSON.stringify({ tag }),
      headers: {
        "Content-Type": "application/json",
      },
    });
    return res.ok;
  }

  async deleteTaggedDiffData(tag: string) {
    const res = await fetch(`${this.prefix}/diffData`, {
      method: "DELETE",
      body: JSON.stringify({ tag }),
      headers: {
        "Content-Type": "application/json",
      },
    });
    return res.ok;
  }

  async getTaggedDiffData(tag: string): Promise<TTaggedDiffData> {
    const path = `${this.prefix}/diffData?tag=${tag}`;
    const result = await ComparatorService.getInstance().get<TTaggedDiffData>(path);
    return result ?? {
      tag: tag,
      graphData: { nodes: [], links: [] },
      cohesionData: [],
      couplingData: [],
      instabilityData: [],
      endpointDataTypesMap: {},
    };
  }

  subscribeToDiffdataTags(
    next: (data: { tag: string; time: number }[]) => void
  ) {
    const path = `${this.prefix}/tags`;
    return ComparatorService.getInstance().subscribeToArray(path, next);
  }
}
