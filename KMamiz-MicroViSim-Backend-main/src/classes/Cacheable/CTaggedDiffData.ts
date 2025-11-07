import { TaggedDiffDataModel } from "../../entities/schema/TaggedDiffData";
import { TTaggedDiffData} from "../../entities/TTaggedDiffData";
import MongoOperator from "../../services/MongoOperator";
import Logger from "../../utils/Logger";
import { Cacheable } from "./Cacheable";

export class CTaggedDiffData extends Cacheable<TTaggedDiffData[]> {
  static readonly uniqueName = "TaggedDiffDatas";
  constructor(initData?: TTaggedDiffData[]) {
    super("TaggedDiffDatas", initData);
    this.setInit(async () => {
      const raw = await MongoOperator.getInstance().findAll(TaggedDiffDataModel);
      const processed = raw.map(doc => {
        // console.log("isMap =",doc.endpointDataTypesMap instanceof Map);
        // console.log("doc.endpointDataTypesMap =",doc.endpointDataTypesMap instanceof Map ? Object.fromEntries(doc.endpointDataTypesMap) : doc.endpointDataTypesMap);
        return {
          ...doc,
          endpointDataTypesMap: doc.endpointDataTypesMap instanceof Map ? Object.fromEntries(doc.endpointDataTypesMap) : doc.endpointDataTypesMap,
        };
      });
    
      this.setData(processed);
    });
    this.setSync(async () => {
      const tagged = this.getData();
      const toDelete = await MongoOperator.getInstance().findAll(
        TaggedDiffDataModel
      );

      try {
        await MongoOperator.getInstance().insertMany(
          tagged,
          TaggedDiffDataModel
        );
        await MongoOperator.getInstance().delete(
          toDelete.map((t) => t._id!),
          TaggedDiffDataModel
        );
      } catch (ex) {
        Logger.error(`Error saving ${this.name}, skipping.`);
        Logger.verbose("", ex);
      }
    });
  }

  getData(): TTaggedDiffData[] {
    const data = super.getData();
    if (!data) return [];
    return data.filter(item => item.time);
  }

  getDataByTag(tag?: string): TTaggedDiffData | null {
    if (tag) {
      const existing = this.getData().filter((d) => d.tag === tag);
      if (existing.length > 0) {
        return existing[0]
      }
    }
    return null;
  }

  getTagsWithTime(): { tag: string; time: number }[] {
    const data = this.getData();
    if (!data) return [];

    const tags = data
      .map((t) => ({ tag: t.tag, time: t.time! })); 

    return Array.from(
      new Set(tags)
    );
  }

  add(taggedData: TTaggedDiffData) {
    const existing = this.getDataByTag(taggedData.tag);
    if (!existing) {
      taggedData.time = Date.now();
      this.setData(
        this.getData().concat(taggedData)
      );
    }
  }

  delete(tag: string) {
    this.setData(
      this.getData().filter((d) => d.tag !== tag)
    );
  }
}
