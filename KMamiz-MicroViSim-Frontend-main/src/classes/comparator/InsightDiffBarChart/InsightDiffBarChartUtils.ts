import { ApexOptions } from "apexcharts";

export default class InsightDiffBarChartUtils {
  protected static readonly DIFF_VERSION_COLORS = ["#FFA500", "#00a2ff"];

  protected static DefaultOptions(
    isNoDiff: boolean,
    stacked: boolean,
    categories: any[],
    title: string,
    subtitle: string = "",
    metricName: string,

  ): ApexOptions {
    return {
      title: {
        text: title.trim() === "" ? undefined : title,
        align: "center",
        offsetY: 0,
      },
      subtitle: {
        text: isNoDiff
          ? `No changes detected in ${metricName}`
          : subtitle.trim() === "" ? undefined : subtitle,
        align: "center",
        style: {
          fontSize: isNoDiff ? "20px" : "14px",
          fontWeight: isNoDiff ? "bold" : undefined,
          color: isNoDiff ? "#2ECC71" : "#666",
        },
      },
      chart: {
        type: "bar",
        stacked,
        animations: {
          enabled: false,
        },
      },
      plotOptions: {
        bar: {
          dataLabels: {
            position: "top",
          },
        },
      },
      dataLabels: {
        enabled: true,
        style: {
          fontSize: "12px",
        },
      },
      stroke: {
        show: true,
        width: 1,
        colors: ["transparent"],
      },
      tooltip: {
        shared: true,
        intersect: false,
      },
      xaxis: {
        categories,
        labels: {
          trim: true,
        },
      },
      legend: {
        position: "top",
        showForSingleSeries: true,
      },
    };
  }

  protected static StackMixedDiffChartOverwriteOpts<T>(
    strategy: {
      x: (d: T) => string | number;
      y: (d: T) => number;
      tooltip: (y: number, seriesIndex: number, dataPointIndex: number) => string;
    }
  ): ApexOptions {
    return {
      stroke: { show: false },
      dataLabels: {
        enabledOnSeries: [0, 1],
        formatter: (value: number) => (value === 0 ? "0" : value.toString()),
        style: { colors: ["#000000", "#000000"] },
      },
      tooltip: {
        shared: true,
        intersect: false,
        y: {
          formatter: (
            y: number,
            { seriesIndex, dataPointIndex }: { seriesIndex: number; dataPointIndex: number }
          ) => strategy.tooltip(y, seriesIndex, dataPointIndex),
        },
      },
      colors: [InsightDiffBarChartUtils.DIFF_VERSION_COLORS[0], InsightDiffBarChartUtils.DIFF_VERSION_COLORS[1]],
    };
  }

  protected static roundToDisplay(n: number) {
    return Math.round(n * 100) / 100;
  }

  protected static generateIntervalTick(min: number, max: number, interval: number) {
    const safeMin = min == 0 ? 0 : Math.min(min, -interval);
    const safeMax = Math.max(interval, max);

    const roundedMin = Math.floor(safeMin / interval) * interval;
    const roundedMax = Math.ceil(safeMax / interval) * interval;

    return {
      min: roundedMin,
      max: roundedMax,
      tickAmount: Math.round((roundedMax - roundedMin) / interval),
    };
  }
}