import { ApexOptions } from "apexcharts";
import { Props } from "react-apexcharts";
import { TInsightDiffCohesion } from "../../../entities/comparator/TInsightDiffCohesion";
import { TInsightDiffCoupling } from "../../../entities/comparator/TInsightDiffCoupling";
import { TInsightDiffInstability } from "../../../entities/comparator/TInsightDiffInstability";
import InsightDiffBarChartUtils from "./InsightDiffBarChartUtils";

// Comparison chart utility for two versions. 
// TODO:Currently supports comparison between exactly two versions only, with plans to extend support for multiple versions in the future.
export default class InsightComparisonBarChartUtils extends InsightDiffBarChartUtils {

  static CreateComparisonBarChart<T extends { name: string }>(
    title: string,
    data: T[],
    toSeriesStrategy: (_: T[], versionTags: string[]) => any[],
    versionTags: string[],
    stacked = false,
    overwriteOpts: Props = {},
    height: number,
    metricName: string,
    subtitle?: string
  ): Props {
    const isNoDiff: boolean = data.length === 0;
    return {
      type: "bar",
      height,
      options: {
        ...InsightComparisonBarChartUtils.DefaultOptions(
          isNoDiff,
          stacked,
          data.map(({ name }) => name),
          title,
          subtitle,
          metricName
        ),
        ...overwriteOpts,
      },
      series: toSeriesStrategy(data, versionTags),
    };
  }


  // Comparison chart overwriteOpts
  private static createServiceComparisonOpts<T>(
    diffData: T[],
    versionTags: string[],
    getValue: (item: T, versionTag: string) => number,
    getName: (item: T) => string,
    yAxisTitleTickInterval: { title: string; tickInterval: number }
  ): ApexOptions {
    if (versionTags.length !== 2) {
      throw new Error("Only supports exactly 2 versions.");
    }
    // Currently only supports comparison between exactly two versions 
    // (TODO: redesign to support multiple versions comparison)
    const versionTag1: string = versionTags[0];
    const versionTag2: string = versionTags[1];

    const base = InsightComparisonBarChartUtils.StackMixedDiffChartOverwriteOpts(
      {
        x: getName,
        y: (d) => getValue(d, versionTag2),
        tooltip: (y) => y.toString(),
      }
    );

    const maxY = diffData.reduce((max, d) => {
      const v1 = getValue(d, versionTag1);
      const v2 = getValue(d, versionTag2);
      return Math.max(max, v1, v2);
    }, 0);
    let tickInterval = yAxisTitleTickInterval.tickInterval;
    while (tickInterval * 10 < maxY) {
      tickInterval *= 10;
    }

    return {
      ...base,
      xaxis: {
        categories: diffData.map(getName),
        labels: {
          trim: true,
        },
      },
      yaxis: [
        {
          title: {
            text: versionTag1,
            style: {
              color: InsightComparisonBarChartUtils.DIFF_VERSION_COLORS[0],
              fontSize: "18px",
            },
          },
          ...InsightComparisonBarChartUtils.generateIntervalTick(0, maxY, tickInterval),
        },
        {
          opposite: true,
          title: {
            text: versionTag2,
            style: {
              color: InsightComparisonBarChartUtils.DIFF_VERSION_COLORS[1],
              fontSize: "18px",
            },
          },
          ...InsightComparisonBarChartUtils.generateIntervalTick(0, maxY, tickInterval),
        },
      ],
    };
  }
  static ServiceCohesionComparisonOpts(
    cohesionDiff: TInsightDiffCohesion[],
    versionTags: string[],
  ): ApexOptions {
    return InsightComparisonBarChartUtils.createServiceComparisonOpts(
      cohesionDiff,
      versionTags,
      (d, versionTag) => d.cohesionsByVersion.find(v => v.versionTag === versionTag)?.totalInterfaceCohesion ?? 0,
      d => d.name,
      { title: "TSIC", tickInterval: 0.1 }
    );
  }
  static ServiceCouplingComparisonOpts(
    couplingDiff: TInsightDiffCoupling[],
    versionTags: string[],
  ): ApexOptions {
    return InsightComparisonBarChartUtils.createServiceComparisonOpts(
      couplingDiff,
      versionTags,
      (d, versionTag) => d.couplingsByVersion.find(v => v.versionTag === versionTag)?.acs ?? 0,
      d => d.name,
      { title: "ACS", tickInterval: 1 }
    );
  }
  static ServiceInstabilityComparisonOpts(
    instabilityDiff: TInsightDiffInstability[],
    versionTags: string[],
  ): ApexOptions {
    return InsightComparisonBarChartUtils.createServiceComparisonOpts(
      instabilityDiff,
      versionTags,
      (d, versionTag) => d.instabilitiesByVersion.find(v => v.versionTag === versionTag)?.instability ?? 0,
      d => d.name,
      { title: "SDP", tickInterval: 0.1 }
    );
  }

  // Comparison chart toSeriesStrategy
  private static createSeriesFromDiffComparison<TDiff, TVersion>(
    diffData: TDiff[],
    versionTags: string[],
    versionDataKey: keyof TDiff,
    getValue: (versionData: TVersion) => number,
  ) {
    if (versionTags.length !== 2) {
      throw new Error("Only supports exactly 2 versions.");
    }

    return versionTags.map((versionTag, index) => ({
      name: versionTag,
      data: diffData.map(d => {
        const versions = d[versionDataKey] as unknown as TVersion[];
        const versionItem = versions.find(v => (v as any).versionTag === versionTag);
        return {
          x: (d as any).name,
          y: InsightComparisonBarChartUtils.roundToDisplay(versionItem ? getValue(versionItem) : 0),
          fillColor: InsightComparisonBarChartUtils.DIFF_VERSION_COLORS[index],
        };
      }),
    }));
  }
  static SeriesFromServiceCohesionComparison(
    cohesionDiff: TInsightDiffCohesion[],
    versionTags: string[],
  ) {
    return InsightComparisonBarChartUtils.createSeriesFromDiffComparison(
      cohesionDiff,
      versionTags,
      'cohesionsByVersion',
      v => (v as any).totalInterfaceCohesion ?? 0,
    );
  }
  static SeriesFromServiceCouplingComparison(
    couplingDiff: TInsightDiffCoupling[],
    versionTags: string[],
  ) {
    return InsightComparisonBarChartUtils.createSeriesFromDiffComparison(
      couplingDiff,
      versionTags,
      'couplingsByVersion',
      v => (v as any).acs ?? 0,
    );
  }
  static SeriesFromServiceInstabilityComparison(
    instabilityDiff: TInsightDiffInstability[],
    versionTags: string[],
  ) {
    return InsightComparisonBarChartUtils.createSeriesFromDiffComparison(
      instabilityDiff,
      versionTags,
      'instabilitiesByVersion',
      v => (v as any).instability ?? 0,
    );
  }

}

