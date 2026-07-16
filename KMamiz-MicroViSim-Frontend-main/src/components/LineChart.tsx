import { ApexOptions } from "apexcharts";
import ReactApexChart from "react-apexcharts";
import LineChartUtils from "../classes/LineChartUtils";

export default function LineChart(props: {
  title?: string;
  filename?: string;
  series: ApexAxisChartSeries;
  height?: number;
  overwriteOptions?: ApexOptions;
  chartId?: string;
}) {
  const options: ApexOptions = {
    ...LineChartUtils.DefaultOptions(props.title || "", props.filename),
    chart: {
      ...LineChartUtils.DefaultOptions(props.title || "", props.filename).chart,
      id: props.chartId,
    },
    ...props.overwriteOptions,
  };

  return (
    <ReactApexChart
      ref={ref}
      type="line"
      height={props.height || 350}
      options={options}
      series={props.series}
    />
  );
};

export default LineChart;