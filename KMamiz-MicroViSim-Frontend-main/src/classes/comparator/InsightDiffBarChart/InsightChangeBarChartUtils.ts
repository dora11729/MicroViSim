import { ApexOptions } from "apexcharts";
import { Props } from "react-apexcharts";
import { TInsightDiffCohesion } from "../../../entities/comparator/TInsightDiffCohesion";
import { TInsightDiffCoupling } from "../../../entities/comparator/TInsightDiffCoupling";
import { TInsightDiffInstability } from "../../../entities/comparator/TInsightDiffInstability";
import InsightDiffBarChartUtils from "./InsightDiffBarChartUtils";


// Change chart utility for two versions, used to display the amount of change between any two specified versions.
export default class InsightChangeBarChartUtils extends InsightDiffBarChartUtils {

  static CreateChangesBarChart<T extends { name: string }>(
    title: string,
    data: T[],
    toSeriesStrategy: (_: T[], versionTag1: string, versionTag2: string) => any[],
    versionTag1: string,
    versionTag2: string,
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
        ...InsightChangeBarChartUtils.DefaultOptions(
          isNoDiff,
          stacked,
          data.map(({ name }) => name),
          title,
          subtitle,
          metricName
        ),
        ...overwriteOpts,
      },
      series: toSeriesStrategy(data, versionTag1, versionTag2),
    };
  }

  // Changes chart overwriteOpts
  private static createChangeBarChartOpts<T>(
    data: T[],
    getName: (d: T) => string,
    getChange: (d: T) => number,
    getYAxisTitle: () => string,
    tickInterval: number,
    getColorFromChange?: (change: number) => string
  ): ApexOptions {
    const changes = data.map(getChange);
    const min = Math.min(...changes);
    const max = Math.max(...changes);
    const maxAbs = Math.max(Math.abs(min), Math.abs(max));

    //Automatically enlarge the tick interval to avoid excessive Y-axis ticks.
    while (tickInterval * 10 < maxAbs * 2) {
      tickInterval *= 10;
    }
    const labelZeroThreshold = tickInterval / 2;
    const createYAxis = (opposite = false) => ({
      opposite,
      title: {
        text: getYAxisTitle(),
        style: {
          fontSize: "18px",
        },
      },
      labels: {
        formatter: (val: number) => {
          if (val < 0 && val > -labelZeroThreshold) return "0";
          return val.toFixed(1);
        }
      },
      ...InsightChangeBarChartUtils.generateIntervalTick(-maxAbs, maxAbs, tickInterval),
    });

    return {
      chart: {
        type: "bar",
        animations: { enabled: false },
      },
      plotOptions: {
        bar: {
          dataLabels: { position: "top" },
          distributed: true,
          columnWidth: "40%",
        },
      },
      dataLabels: {
        enabled: true,
        formatter: (val: number) => val.toString(),
        style: {
          colors: ["#000"],
        },
      },
      xaxis: {
        categories: data.map(getName),
        labels: {
        },
      },
      yaxis: [createYAxis(false), createYAxis(true)],
      grid: {
        yaxis: {
          lines: { show: true },
        },
        row: { colors: undefined },
        strokeDashArray: 0,
      },
      annotations: {
        yaxis: [{
          y: 0,
          borderColor: "#000000",
          strokeDashArray: 0,
        }],
      },
      tooltip: {
        y: { formatter: (y: number) => y.toString() },
      },
      colors: data.map((d) => {
        const change = getChange(d);
        if (getColorFromChange) return getColorFromChange(change);
        return change >= 0 ? "#28a745" : "#dc3545";
      }),
      legend: {
        position: "top",
        show: true,
        customLegendItems: ['Increase', 'Decrease'],
        markers: {
          fillColors: ['#28a745', '#dc3545'],
        }
      }

    };
  }
  static CohesionChangeBarChartOpts(
    cohesionDiff: TInsightDiffCohesion[],
    versionTagV1: string,
    versionTagV2: string
  ): ApexOptions {
    return InsightChangeBarChartUtils.createChangeBarChartOpts(
      cohesionDiff,
      (d) => d.name,
      (d) => {
        const v1 = d.cohesionsByVersion.find(v => v.versionTag === versionTagV1)?.totalInterfaceCohesion ?? 0;
        const v2 = d.cohesionsByVersion.find(v => v.versionTag === versionTagV2)?.totalInterfaceCohesion ?? 0;
        return v2 - v1;
      },
      () => "TSIC Change",
      0.1
    );
  }
  static CouplingChangeBarChartOpts(
    couplingDiff: TInsightDiffCoupling[],
    versionTagV1: string,
    versionTagV2: string
  ): ApexOptions {
    return InsightChangeBarChartUtils.createChangeBarChartOpts(
      couplingDiff,
      (d) => d.name,
      (d) => {
        const v1 = d.couplingsByVersion.find(v => v.versionTag === versionTagV1)?.acs ?? 0;
        const v2 = d.couplingsByVersion.find(v => v.versionTag === versionTagV2)?.acs ?? 0;
        return v2 - v1;
      },
      () => "ACS Change",
      1,
    );
  }
  static InstabilityChangeBarChartOpts(
    instabilityDiff: TInsightDiffInstability[],
    versionTagV1: string,
    versionTagV2: string
  ): ApexOptions {
    return InsightChangeBarChartUtils.createChangeBarChartOpts(
      instabilityDiff,
      d => d.name,
      d => {
        const v1 = d.instabilitiesByVersion.find(v => v.versionTag === versionTagV1)?.instability ?? 0;
        const v2 = d.instabilitiesByVersion.find(v => v.versionTag === versionTagV2)?.instability ?? 0;
        return v2 - v1;
      },
      () => "SDP Change",
      0.1,
    );
  }

  // Changes chart toSeriesStrategy
  private static SeriesFromChange<T>(
    diffData: T[],
    versionTagV1: string,
    versionTagV2: string,
    getValue: (d: T, versionTag: string) => number,
    seriesName: string
  ) {
    return [
      {
        name: seriesName,
        data: diffData.map((d) => {
          const v1 = getValue(d, versionTagV1);
          const v2 = getValue(d, versionTagV2);
          const diff = InsightChangeBarChartUtils.roundToDisplay(v2 - v1);
          return {
            x: (d as any).name,
            y: diff,
            fillColor: diff >= 0 ? "#28a745" : "#dc3545",// green for increase, red for decrease
          };
        }),
      },
    ];
  }
  static SeriesFromCohesionChange(
    cohesionDiff: TInsightDiffCohesion[],
    versionTagV1: string,
    versionTagV2: string
  ) {
    return InsightChangeBarChartUtils.SeriesFromChange(
      cohesionDiff,
      versionTagV1,
      versionTagV2,
      (d, tag) => d.cohesionsByVersion.find(v => v.versionTag === tag)?.totalInterfaceCohesion ?? 0,
      "TSIC Change"
    );
  }
  static SeriesFromCouplingChange(
    couplingDiff: TInsightDiffCoupling[],
    versionTagV1: string,
    versionTagV2: string
  ) {
    return InsightChangeBarChartUtils.SeriesFromChange(
      couplingDiff,
      versionTagV1,
      versionTagV2,
      (d, tag) => d.couplingsByVersion.find(v => v.versionTag === tag)?.acs ?? 0,
      "ACS Change"
    );
  }
  static SeriesFromInstabilityChange(
    instabilityDiff: TInsightDiffInstability[],
    versionTagV1: string,
    versionTagV2: string
  ) {
    return InsightChangeBarChartUtils.SeriesFromChange(
      instabilityDiff,
      versionTagV1,
      versionTagV2,
      (d, tag) => d.instabilitiesByVersion.find(v => v.versionTag === tag)?.instability ?? 0,
      "SDP Change"
    );
  }

}

