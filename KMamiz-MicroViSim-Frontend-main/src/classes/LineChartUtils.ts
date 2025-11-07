import { ApexOptions } from "apexcharts";
import {
  FieldIndex,
  TLineChartData,
  TLineChartDataFields,
} from "../entities/TLineChartData";
import { TRequestInfoChartData } from "../entities/TRequestInfoChartData";
import { Color } from "./ColorUtils";
import Config from "../../Config";

export default class LineChartUtils {
  static DefaultOptions(title: string): ApexOptions {
    return {
      title: {
        text: title,
        align: "center",
      },
      chart: {
        type: "line",
        animations: {
          enabled: false,
        },
      },
      dataLabels: {
        enabled: false,
      },
      stroke: {
        curve: "smooth",
        width: 3,
      },
      legend: {
        horizontalAlign: "left",
      },
      xaxis: {
        type: "datetime",
        labels: {
          formatter: (_, ts) => {
            const date = new Date(ts as any);
            const month = date.getUTCMonth() + 1;
            const day = date.getUTCDate();
            const hours = String(date.getUTCHours()).padStart(2, "0");
            const minutes = String(date.getUTCMinutes()).padStart(2, "0");

            if (Config.backendConfig.SimulatorMode) {
              return `Day${day} ${hours}:${minutes}`;  // e.g., "Day1 03:00"
            } else {
              return `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")} ${hours}:${minutes}`;
            }
          },
        },
      },
    };
  }

  static MappedBaseDataToSeriesData(
    data: TLineChartData,
    field: TLineChartDataFields
  ): ApexAxisChartSeries {
    const fIndex = FieldIndex.indexOf(field);
    return data.services.map((s, i) => ({
      name: s,
      color: Color.generateFromString(s).hex,
      data: data.dates.map((d, j) => ({
        x: d,
        y: Math.round((data.metrics[j][i][fIndex] || 0) * 1000) / 1000,
        fillColor: Color.generateFromString(s).hex,
      })),
    }));
  }

  static MapRequestInfoToRequestSeriesData(
    data: TRequestInfoChartData
  ): ApexAxisChartSeries {
    const requestSeries = {
      name: "2XX/3XX",
      color: "#0000ff",
      data: data.time.map((t, i) => ({
        x: t,
        y: data.requests[i],
      })),
    };

    const clientErrorSeries = {
      name: "4XX",
      color: "#ffff00",
      data: data.time.map((t, i) => ({
        x: t,
        y: data.clientErrors[i],
      })),
    };

    const serverErrorSeries = {
      name: "5XX",
      color: "#ff0000",
      data: data.time.map((t, i) => ({
        x: t,
        y: data.serverErrors[i],
      })),
    };
    return [requestSeries, clientErrorSeries, serverErrorSeries];
  }

  static MapRequestInfoToLatencySeriesData(
    data: TRequestInfoChartData
  ): ApexAxisChartSeries {
    return [
      {
        name: "Latency CV",
        color: "#4b0082",
        data: data.time.map((t, i) => ({
          x: t,
          y: Math.round((data.latencyCV[i] || 0) * 1000) / 1000,
        })),
      },
    ];
  }
}
