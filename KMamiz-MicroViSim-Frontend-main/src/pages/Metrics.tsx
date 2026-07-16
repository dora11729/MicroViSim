import Config from "../../Config";
import {
  Grid,
  Box,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Button,
  CircularProgress,
} from "@mui/material";
import { makeStyles } from "@mui/styles";
import DownloadIcon from "@mui/icons-material/Download";
import { useEffect, useState } from "react";
import LineChartUtils from "../classes/LineChartUtils";
import LineChart from "../components/LineChart";
import {
  TLineChartData,
  TLineChartDataFields,
} from "../entities/TLineChartData";
import GraphService from "../services/GraphService";
import { TServiceStatistics } from "../entities/TStatistics";
import ServiceStatisticsTable from '../components/ServiceStatisticsTable';

const useStyles = makeStyles(() => ({
  root: {
    width: "100%",
    overflowX: "clip",
    paddingTop: "1em",
  },
  select: {
    minWidth: 130,
    marginRight: "1em",
  },
  pageHeader: {
    borderBottom: '0.2em solid #ccc',
    boxShadow: '0.0em  0.4em 0.5em rgba(0, 0, 0, 0.1)',
    position: "fixed",
    top: "4em",
    left: "0em",
    backgroundColor: 'white',
    zIndex: 99,
  },
  pageBody: {
    marginTop: '8em',
  },
}));

export default function Metrics() {
  const classes = useStyles();
  const [timeOffset, setTimeOffset] = useState<number>(Config.backendConfig.SimulatorMode ? -86400 * 7 : 1800); //display data for the last 30 minutes by default
  const [mappedHistoricalData, setMappedHistoricalData] = useState<TLineChartData>();
  const [statistics, setStatistics] = useState<TServiceStatistics[]>([]);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    const unsubscribe = [
      GraphService.getInstance().subscribeToLineChartData(
        setMappedHistoricalData, timeOffset * 1000,
      ),
    ];
    return () => { unsubscribe.forEach((un) => un()); };
  }, [timeOffset]);

  useEffect(() => {
    const unsubscribeStatistics = [
      GraphService.getInstance().subscribeToServiceHistoricalStatistics(
        setStatistics, timeOffset * 1000
      ),
    ];
    return () => { unsubscribeStatistics.forEach((uns) => uns()); };
  }, [timeOffset]);

  const areaCharts: {
    name: string;
    field: TLineChartDataFields;
    options?: any;
  }[] = [
      { name: "Requests", field: "requests" },
      { name: "Risks", field: "risk", options: { yaxis: { max: 1, min: 0 } } },
      { name: "RequestErrors", field: "requestErrors" },
      { name: "Service Errors", field: "serverErrors" },
      { name: "Latency (Coefficient of Variation)", field: "latencyCV" },
      { name: "LatencyMean", field: "latencyMean" },
      { name: "LatencyMean (No Downstream)", field: "latencyMeanNoDownstream" },
      { name: "LatencyP95", field: "latencyP95" },
      { name: "Replicas", field: "replicas" },
      { name: "Utilization", field: "utilization", options: { yaxis: { min: 0 } } },
    ];

  const statisticsTimeOptions = Config.backendConfig.SimulatorMode
    ? [{ label: 'simulation', value: 0 }]
    : [
      { label: 'last 10 min', value: 600 },
      { label: 'last 30 min', value: 1800 },
      { label: 'last 1 hr', value: 3600 },
      { label: 'last 3 hr', value: 10800 },
      { label: 'last 6 hr', value: 21600 },
      { label: 'last 12 hr', value: 43200 },
      { label: 'last 1 day', value: 86400 },
      { label: 'last 7 days', value: 86400 * 7 },
    ];

  function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function downloadAll() {
    setDownloading(true);
    try {
      const toolbars = document.querySelectorAll(".apexcharts-toolbar");

      // PNG
      for (const toolbar of Array.from(toolbars)) {
        const menuIcon = toolbar.querySelector(".apexcharts-menu-icon") as HTMLElement;
        menuIcon?.click();
        await delay(100);
        const menuItems = toolbar.querySelectorAll(".apexcharts-menu-item");
        const pngItem = Array.from(menuItems).find(el => el.textContent === "Download PNG") as HTMLElement;
        pngItem?.click();
        await delay(300);
      }

      // CSV
      for (const toolbar of Array.from(toolbars)) {
        const menuIcon = toolbar.querySelector(".apexcharts-menu-icon") as HTMLElement;
        menuIcon?.click();
        await delay(100);
        const menuItems = toolbar.querySelectorAll(".apexcharts-menu-item");
        const csvItem = Array.from(menuItems).find(el => el.textContent === "Download CSV") as HTMLElement;
        csvItem?.click();
        await delay(300);
      }
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Box className={classes.root}>
      <Grid container padding={1} spacing={0.5} className={classes.pageHeader}>
        <Grid item xs={12} margin="1em 1em 0 0" style={{ display: "flex", alignItems: "center" }}>
          {!Config.backendConfig.SimulatorMode && (
            <FormControl className={classes.select}>
              <InputLabel id="lt-label">Time Offset</InputLabel>
              <Select
                labelId="lt-label"
                label="Time Offset"
                onChange={(e) => setTimeOffset(+e.target.value)}
                value={timeOffset}
              >
                {statisticsTimeOptions.map((option) => (
                  <MenuItem key={`lt-item-${option.value}`} value={option.value}>
                    {option.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          )}
          <Button
            variant="contained"
            startIcon={downloading ? <CircularProgress size={16} color="inherit" /> : <DownloadIcon />}
            onClick={downloadAll}
            disabled={downloading || !mappedHistoricalData}
          >
            {downloading ? "Downloading..." : "Download All"}
          </Button>
        </Grid>
      </Grid>

      <Grid container className={classes.pageBody}>
        {mappedHistoricalData
          ? areaCharts.map((c) => (
            <Grid key={c.name} item xs={6}>
              <LineChart
                title={c.name}
                filename={c.field}
                series={LineChartUtils.MappedBaseDataToSeriesData(mappedHistoricalData, c.field)}
                overwriteOptions={c.options}
              />
            </Grid>
          ))
          : null}
        <Grid item xs={12} padding={1}>
          <ServiceStatisticsTable servicesStatistics={statistics} />
        </Grid>
      </Grid>
    </Box>
  );
}
