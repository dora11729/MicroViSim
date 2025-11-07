import { TTotalServiceInterfaceCohesion } from "../entities/TTotalServiceInterfaceCohesion";
import { TServiceCoupling } from "../entities/TServiceCoupling";
import { TServiceInstability } from "../entities/TServiceInstability";
import { TInsightDiffCohesion } from "../entities/comparator/TInsightDiffCohesion";
import { TInsightDiffCoupling } from "../entities/comparator/TInsightDiffCoupling";
import { TInsightDiffInstability } from "../entities/comparator/TInsightDiffInstability";


export class InsightComparator {

    private static instance?: InsightComparator;
    static getInstance = () => this.instance || (this.instance = new this());
    private constructor() { };

    mergeCohesionDiffData(
        versionsData: {
            versionTag: string,
            cohesionData: TTotalServiceInterfaceCohesion[]
        }[]
    ): TInsightDiffCohesion[] {
        return this.mergeInsightDiffData(
            versionsData.map(v => ({ versionTag: v.versionTag, data: v.cohesionData })),
            data => data,
            (item, versionTag) => ({
                versionTag,
                dataCohesion: item?.dataCohesion ?? 0,
                usageCohesion: item?.usageCohesion ?? 0,
                totalInterfaceCohesion: item?.totalInterfaceCohesion ?? 0,
            }),
            (name, byVersion) => ({
                uniqueServiceName: name,
                name,
                cohesionsByVersion: byVersion,
            }),
            diff => diff.cohesionsByVersion.map(v => v.totalInterfaceCohesion)
        );
    }

    mergeCouplingDiffData(
        versionsData: {
            versionTag: string;
            couplingData: TServiceCoupling[];
        }[]
    ): TInsightDiffCoupling[] {
        return this.mergeInsightDiffData(
            versionsData.map(v => ({ versionTag: v.versionTag, data: v.couplingData })),
            data => data,
            (item, versionTag) => ({
                versionTag,
                ais: item?.ais ?? 0,
                ads: item?.ads ?? 0,
                acs: item?.acs ?? 0,
            }),
            (name, byVersion) => ({
                uniqueServiceName: name,
                name,
                couplingsByVersion: byVersion,
            }),
            diff => diff.couplingsByVersion.map(v => v.acs)
        );
    }

    mergeInstabilityDiffData(
        versionsData: {
            versionTag: string;
            instabilityData: TServiceInstability[];
        }[]
    ): TInsightDiffInstability[] {
        return this.mergeInsightDiffData(
            versionsData.map(v => ({ versionTag: v.versionTag, data: v.instabilityData })),
            data => data,
            (item, versionTag) => ({
                versionTag,
                dependingBy: item?.dependingBy ?? 0,
                dependingOn: item?.dependingOn ?? 0,
                instability: item?.instability ?? 0,
            }),
            (name, byVersion) => ({
                uniqueServiceName: name,
                name,
                instabilitiesByVersion: byVersion,
            }),
            diff => diff.instabilitiesByVersion.map(v => v.instability)
        );
    }

    private mergeInsightDiffData = <TItem, TPerVersion, TDiff>(
        versionsData: {
            versionTag: string;
            data: TItem[];
        }[],
        getItems: (data: TItem[]) => TItem[],
        buildPerVersion: (item: TItem | undefined, versionTag: string) => TPerVersion,
        buildDiff: (serviceName: string, items: TPerVersion[]) => TDiff,
        getCompareValues: (diff: TDiff) => number[]
    ): TDiff[] => {
        const allServiceNames = new Set<string>();

        versionsData.forEach(version => {
            getItems(version.data).forEach(item => {
                allServiceNames.add((item as any).name);
            });
        });

        const merged: TDiff[] = [];

        allServiceNames.forEach(serviceName => {
            const perVersion = versionsData.map(version => {
                const item = getItems(version.data).find(i => (i as any).name === serviceName);
                return buildPerVersion(item, version.versionTag);
            });

            const diff = buildDiff(serviceName, perVersion);
            merged.push(diff);
        });

        return merged.filter(diff => {
            const values = getCompareValues(diff);
            return !values.every(v => v === values[0]);
        });
    };
}

