import { ApexOptions } from "apexcharts";
import ReactApexChart from "react-apexcharts";
import { forwardRef } from "react";
import LineChartUtils from "../classes/LineChartUtils";

const LineChart = forwardRef<ReactApexChart, {
  title?: string;
  filename?: string;
  series: ApexAxisChartSeries;
  height?: number;
  overwriteOptions?: ApexOptions;
  chartId?: string;
}>((props, ref) => {
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
});

export default LineChart;
