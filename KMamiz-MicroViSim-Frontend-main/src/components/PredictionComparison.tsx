import { useEffect, useState } from "react";
import {
  Box,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import LineChart from "./LineChart";
import { TPredictionComparison, TPredictionError } from "../entities/TPredictionComparison";

const ACTUAL_COLOR = "#212121";
const METHOD_STYLE: Record<string, { label: string; color: string }> = {
  naive: { label: "Naive (last hour)", color: "#9e9e9e" },
  linearInput: { label: "Linear input", color: "#43a047" },
  rectify: { label: "Rectify", color: "#e53935" },
  minute: { label: "Minute model", color: "#1e88e5" },
  hourly: { label: "Hourly model", color: "#fb8c00" },
};

const styleOf = (method: string) => METHOD_STYLE[method] ?? { label: method, color: "#607d8b" };
const formatNumber = (value: number | null, digits: number) => (value === null ? "-" : value.toFixed(digits));

/*
  Every model-scaled service's next-hour forecasts, one service at a time: the line for
  hour t is what each method forecast for t from hours before it, so it sits on the hour
  it forecast and lines up with the actual requests.
*/
export default function PredictionComparison({ comparison }: { comparison: TPredictionComparison }) {
  const [selected, setSelected] = useState(comparison.services[0]?.uniqueServiceName ?? "");

  // A new run may not have the service that was selected.
  useEffect(() => {
    if (!comparison.services.some(s => s.uniqueServiceName === selected)) {
      setSelected(comparison.services[0]?.uniqueServiceName ?? "");
    }
  }, [comparison, selected]);

  const service = comparison.services.find(s => s.uniqueServiceName === selected);
  if (!service) return null;

  const series: ApexAxisChartSeries = [
    {
      name: "Actual",
      color: ACTUAL_COLOR,
      data: comparison.dates.map((x, j) => ({ x, y: Math.round(service.actual[j]) })),
    },
    ...comparison.methods.map(method => ({
      name: `${styleOf(method).label}${method === comparison.configuredMethod ? " (scaling)" : ""}`,
      color: styleOf(method).color,
      data: comparison.dates.map((x, j) => {
        const value = service.predictions[method]?.[j] ?? null;
        return { x, y: value === null ? null : Math.round(value) };
      }),
    })),
  ];
  // The actual line and the method that scaled stand out; naive is dashed.
  const widths = [4, ...comparison.methods.map(m => (m === comparison.configuredMethod ? 3 : 2))];
  const dashes = [0, ...comparison.methods.map(m => (m === "naive" ? 5 : 0))];

  const scored = comparison.methods.filter(m => service.errors[m]?.mae !== null);
  const best = scored.reduce<string | null>(
    (bestSoFar, m) => (bestSoFar === null || service.errors[m].mae! < service.errors[bestSoFar].mae! ? m : bestSoFar),
    null
  );

  return (
    <Box>
      <FormControl style={{ minWidth: 320, margin: "1em" }}>
        <InputLabel id="prediction-service-label">Service</InputLabel>
        <Select
          labelId="prediction-service-label"
          label="Service"
          value={selected}
          onChange={e => setSelected(String(e.target.value))}
        >
          {comparison.services.map(s => (
            <MenuItem key={s.uniqueServiceName} value={s.uniqueServiceName}>
              {`${s.service}.${s.namespace} (${s.version}) - ${s.model}`}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <LineChart
        title={`Predicted Requests - ${service.service}.${service.namespace} (${service.version})`}
        filename="predictedRequests"
        series={series}
        overwriteOptions={{
          stroke: { curve: "straight", width: widths, dashArray: dashes },
          yaxis: { min: 0, title: { text: "requests / hour" } },
        }}
      />

      <TableContainer component={Paper} style={{ marginTop: 8 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Method</TableCell>
              <TableCell align="right">MAE (req/h)</TableCell>
              <TableCell align="right">RMSE (req/h)</TableCell>
              <TableCell align="right">MAE vs naive</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {comparison.methods.map(method => {
              const error: TPredictionError = service.errors[method] ?? { mae: null, rmse: null, maeVsNaive: null };
              const weight = method === best ? "bold" : "normal";
              return (
                <TableRow key={method}>
                  <TableCell style={{ fontWeight: weight }}>
                    <span style={{ color: styleOf(method).color, marginRight: 6 }}>●</span>
                    {styleOf(method).label}
                    {method === comparison.configuredMethod ? " (scaling)" : ""}
                    {method === best ? " - lowest MAE" : ""}
                  </TableCell>
                  <TableCell align="right" style={{ fontWeight: weight }}>{formatNumber(error.mae, 1)}</TableCell>
                  <TableCell align="right" style={{ fontWeight: weight }}>{formatNumber(error.rmse, 1)}</TableCell>
                  <TableCell align="right" style={{ fontWeight: weight }}>{formatNumber(error.maeVsNaive, 3)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
      {service.minuteChoice && (
        <Typography variant="caption" display="block" style={{ margin: "0.5em 1em 0" }}>
          Minute model: each hour uses whichever of linear input and rectify was closer over the
          last 24 hours ({["linearInput", "rectify"].map(strategy =>
            `${styleOf(strategy).label.toLowerCase()} ${service.minuteChoice!.filter(c => c === strategy).length} h`
          ).join(", ")}).
        </Typography>
      )}
      <Typography variant="caption" display="block" style={{ margin: "0.5em 1em" }}>
        Scored over the {service.scoredSlots} hours every method forecast. Each forecast for an hour
        uses only the hours before it; MAE vs naive below 1 beats repeating the last hour.
      </Typography>
    </Box>
  );
}
