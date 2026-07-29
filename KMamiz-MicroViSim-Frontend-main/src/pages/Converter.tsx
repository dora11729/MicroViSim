import Config from "../../Config";
import {
  Box,
  Grid,
  Typography,
  Button,
  Paper,
  TextField,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Alert,
  LinearProgress,
  CircularProgress,
  Chip,
  Divider,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Stepper,
  Step,
  StepLabel,
  InputAdornment,
} from "@mui/material";
import { makeStyles } from "@mui/styles";
import MonacoEditor from "@monaco-editor/react";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import DownloadIcon from "@mui/icons-material/Download";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import SearchIcon from "@mui/icons-material/Search";
import FlashOnIcon from "@mui/icons-material/FlashOn";
import { useRef, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import Swal from "sweetalert2";
import withReactContent from "sweetalert2-react-content";
import ConverterApiService from "../services/ConverterApiService";
import {
  buildLoadSimulationYaml,
  downloadTextFile,
  mergeLoadSimulationIntoYaml,
} from "../classes/ConverterYamlUtils";
import {
  ConverterResult,
  ConverterRunOptions,
  K6ConverterConfig,
} from "../entities/TConverter";

const SwalHandler = withReactContent(Swal);

const useStyles = makeStyles(() => ({
  root: {
    width: "100%",
    overflowX: "clip",
    paddingTop: "1em",
  },
  pageHeader: {
    borderBottom: "0.2em solid #ccc",
    boxShadow: "0.0em 0.4em 0.5em rgba(0, 0, 0, 0.1)",
    position: "fixed",
    top: "4em",
    left: "0em",
    backgroundColor: "white",
    zIndex: 99,
  },
  pageBody: {
    marginTop: "10em",
    padding: "0 1em 3em",
  },
}));

const TYPE_COLOR: Record<
  string,
  "default" | "primary" | "secondary" | "success" | "warning" | "error" | "info"
> = {
  stable: "default",
  jitter: "info",
  spike: "warning",
  gradualDrift: "error",
  loadDriven: "primary",
};

const DEFAULT_OPTIONS: Required<
  Pick<
    ConverterRunOptions,
    | "slotsPerHour"
    | "driftDetectionThresholdMs"
    | "lowLoadThresholdPct"
    | "searchRangePct"
    | "searchSteps"
    | "spikeRatioThreshold"
    | "loadCorrelationThreshold"
    | "jitterCvThreshold"
  >
> & {
  fanOutFactors: string;
  mapeWeights: { latency: string; errorRate: string; rps: string };
} = {
  slotsPerHour: 1,
  fanOutFactors: "{}",
  driftDetectionThresholdMs: 2.0,
  lowLoadThresholdPct: 0.5,
  searchRangePct: 0.3,
  searchSteps: 7,
  spikeRatioThreshold: 3.0,
  loadCorrelationThreshold: 0.6,
  jitterCvThreshold: 0.2,
  mapeWeights: { latency: "0.5", errorRate: "0.3", rps: "0.2" },
};

function MapeBadge({ value, label }: { value: number; label: string }) {
  const color = value < 20 ? "#2e7d32" : value < 50 ? "#e65100" : "#c62828";
  return (
    <Box sx={{ textAlign: "center", px: 1.5 }}>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="h6" sx={{ color, fontWeight: 700 }}>
        {value.toFixed(1)}%
      </Typography>
    </Box>
  );
}

function DelayTypeChip({ type }: { type: string }) {
  return (
    <Chip
      label={type}
      color={TYPE_COLOR[type] ?? "default"}
      size="small"
      sx={{ mr: 0.5, mb: 0.5, fontFamily: "monospace" }}
    />
  );
}

function parseJsonField(raw: string, fieldName: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${fieldName} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : `Invalid ${fieldName} JSON`);
  }
}

function buildRunOptions(form: typeof DEFAULT_OPTIONS): ConverterRunOptions {
  const weights = {
    latency: parseFloat(form.mapeWeights.latency),
    errorRate: parseFloat(form.mapeWeights.errorRate),
    rps: parseFloat(form.mapeWeights.rps),
  };
  const weightSum = weights.latency + weights.errorRate + weights.rps;
  if (Number.isNaN(weightSum) || Math.abs(weightSum - 1) > 0.001) {
    throw new Error("MAPE weights must be numbers that sum to 1");
  }

  return {
    slotsPerHour: form.slotsPerHour,
    fanOutFactors: parseJsonField(form.fanOutFactors, "fanOutFactors") as Record<string, number>,
    driftDetectionThresholdMs: form.driftDetectionThresholdMs,
    lowLoadThresholdPct: form.lowLoadThresholdPct,
    searchRangePct: form.searchRangePct,
    searchSteps: form.searchSteps,
    spikeRatioThreshold: form.spikeRatioThreshold,
    loadCorrelationThreshold: form.loadCorrelationThreshold,
    jitterCvThreshold: form.jitterCvThreshold,
    mapeWeights: weights,
  };
}

type GeneratedNameMap = Record<string, { service: string; endpoint: string }>;

/**
 * k6 stores the request URL in `name`; each distinct URL must still be a key in
 * nameMap.  The suggested endpoint intentionally removes volatile URL parts so
 * that users can review a stable route such as `/comments/:id`.
 */
function buildSuggestedK6NameMap(csvText: string): GeneratedNameMap {
  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) throw new Error("k6 CSV must have a header and at least one data row.");

  const delimiter = lines[0].includes("\t") ? "\t" : ",";
  const header = lines[0].replace(/^\uFEFF/, "").split(delimiter).map((column) => column.trim().toLowerCase());
  const nameIndex = header.indexOf("name");
  const methodIndex = header.indexOf("method");
  if (nameIndex < 0 || methodIndex < 0) {
    throw new Error("This file does not contain the k6 name and method columns.");
  }

  const mapping: GeneratedNameMap = {};
  for (const line of lines.slice(1)) {
    // k6 URL/name fields do not contain delimiters. The converter itself uses
    // the same simple format, and this also supports tab-delimited exports.
    const columns = line.split(delimiter);
    const name = columns[nameIndex]?.trim();
    const method = columns[methodIndex]?.trim().toUpperCase();
    if (!name || !method || mapping[name]) continue;

    let path = name;
    try {
      path = new URL(name).pathname || "/";
    } catch {
      path = name.split("?")[0] || "/";
    }
    const normalizedPath = path
      .split("/")
      .map((segment) => {
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segment);
        return isUuid || /^\d+$/.test(segment) ? ":id" : segment;
      })
      .join("/") || "/";
    const firstSegment = normalizedPath.split("/").find(Boolean) || "unknown";

    mapping[name] = {
      service: `${firstSegment}-service`,
      endpoint: normalizedPath,
    };
  }

  if (Object.keys(mapping).length === 0) {
    throw new Error("No request names were found in this k6 CSV.");
  }
  return mapping;
}

export default function Converter() {
  const classes = useStyles();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);

  const [activeStep, setActiveStep] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [isK6, setIsK6] = useState(false);
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [nameMap, setNameMap] = useState("{}");
  const [replicaCounts, setReplicaCounts] = useState("{}");
  const [mappingHint, setMappingHint] = useState("");
  const [jsonErrors, setJsonErrors] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [result, setResult] = useState<ConverterResult | null>(null);
  const [standardCsv, setStandardCsv] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [namespace, setNamespace] = useState("default");
  const [version, setVersion] = useState("v1");
  const [yamlCopied, setYamlCopied] = useState(false);

  const steps = ["Upload & Configure", "Run", "Results"];

  const validateJsonFields = (): boolean => {
    const errors: Record<string, string> = {};
    const fields: Array<[string, string]> = [
      ["fanOutFactors", options.fanOutFactors],
    ];
    if (isK6) {
      fields.push(["nameMap", nameMap], ["replicaCounts", replicaCounts]);
    }

    for (const [key, raw] of fields) {
      try {
        parseJsonField(raw, key);
      } catch (e) {
        errors[key] = e instanceof Error ? e.message : "Invalid JSON";
      }
    }

    try {
      buildRunOptions(options);
    } catch (e) {
      errors.mapeWeights = e instanceof Error ? e.message : "Invalid MAPE weights";
    }

    setJsonErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleRun = async () => {
    if (!file || !validateJsonFields()) return;

    setRunning(true);
    setErrorMsg("");
    setActiveStep(1);

    try {
      const runOptions = buildRunOptions(options);
      const k6Config: K6ConverterConfig = {
        nameMap: parseJsonField(nameMap, "nameMap") as K6ConverterConfig["nameMap"],
        replicaCounts: parseJsonField(replicaCounts, "replicaCounts") as Record<string, number>,
      };

      const pipeline = await ConverterApiService.getInstance().runPipeline(
        file,
        isK6,
        runOptions,
        k6Config,
      );

      setResult(pipeline.result);
      setStandardCsv(pipeline.standardCsv ?? null);
      setYamlCopied(false);
      setActiveStep(2);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setActiveStep(0);
    } finally {
      setRunning(false);
    }
  };

  const handleGenerateMapping = async () => {
    if (!file) return;
    try {
      const generated = buildSuggestedK6NameMap(await file.text());
      setNameMap(JSON.stringify(generated, null, 2));
      setMappingHint(`Generated ${Object.keys(generated).length} mapping entries. Review service and endpoint names before running.`);
      setErrorMsg("");
    } catch (e) {
      setMappingHint("");
      setErrorMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const filteredEndpoints = useMemo(() => {
    if (!result) return [];
    const entries = Object.entries(result.convertedEndpoints);
    const q = searchQuery.trim().toLowerCase();
    const filtered = q
      ? entries.filter(
          ([key, ep]) =>
            key.toLowerCase().includes(q) ||
            ep.service.toLowerCase().includes(q) ||
            ep.endpoint.toLowerCase().includes(q),
        )
      : entries;
    return filtered.sort(([, a], [, b]) => a.mape.weighted - b.mape.weighted);
  }, [result, searchQuery]);

  const generatedYaml = useMemo(
    () => (result ? buildLoadSimulationYaml(result, namespace, version) : ""),
    [result, namespace, version],
  );

  const handleDownloadYaml = () => {
    if (!generatedYaml) return;
    downloadTextFile(
      generatedYaml,
      "loadSimulation.yaml",
      "text/yaml",
    );
  };

  const handleDownloadStandardCsv = () => {
    if (!standardCsv) return;
    downloadTextFile(standardCsv, "converted-standard.csv", "text/csv");
  };

  const handleCopyYaml = async () => {
    if (!generatedYaml) return;
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(generatedYaml);
      } else {
        // Clipboard API is unavailable for HTTP or older embedded browsers.
        const textArea = document.createElement("textarea");
        textArea.value = generatedYaml;
        textArea.setAttribute("readonly", "");
        textArea.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;";
        document.body.appendChild(textArea);
        textArea.select();
        const copied = document.execCommand("copy");
        document.body.removeChild(textArea);
        if (!copied) throw new Error("The browser blocked clipboard access.");
      }
      setYamlCopied(true);
      window.setTimeout(() => setYamlCopied(false), 1800);
    } catch (e) {
      await SwalHandler.fire({
        icon: "error",
        title: "Unable to copy YAML",
        text: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const handleApplyToSimulator = async () => {
    if (!result || !Config.backendConfig.SimulatorMode) return;

    const existingYaml = localStorage.getItem("simulatorYaml") ?? "";
    const merged = mergeLoadSimulationIntoYaml(existingYaml, result, namespace, version);
    localStorage.setItem("simulatorYaml", merged);

    const confirm = await SwalHandler.fire({
      icon: "success",
      title: "Applied to Simulator",
      text: "loadSimulation section has been merged into the simulator YAML editor.",
      showCancelButton: true,
      confirmButtonText: "Open Simulator",
      cancelButtonText: "Stay here",
    });

    if (confirm.isConfirmed) {
      navigate("/simulatorHome");
    }
  };

  const handleReset = () => {
    setActiveStep(0);
    setRunning(false);
    // Keep the selected input so users can adjust settings and run again.
    // The file input is already cleared after every selection, so selecting a
    // different file remains possible.
    setResult(null);
    setStandardCsv(null);
    setErrorMsg("");
    setSearchQuery("");
    setYamlCopied(false);
  };

  const handleResetConfiguration = () => {
    setIsK6(false);
    setOptions(DEFAULT_OPTIONS);
    setNameMap("{}");
    setReplicaCounts("{}");
    setMappingHint("");
    setJsonErrors({});
    setNamespace("default");
    setVersion("v1");
  };

  const updateOption = <K extends keyof typeof DEFAULT_OPTIONS>(
    key: K,
    value: (typeof DEFAULT_OPTIONS)[K],
  ) => {
    setOptions((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <Box className={classes.root}>
      <Grid container padding={1} spacing={0.5} className={classes.pageHeader}>
        <Grid item xs={12} margin="1em 1em 0.5em 1em">
          <Typography variant="h5" fontWeight={700} gutterBottom>
            Auto Converter
          </Typography>
          <Typography variant="body2" color="text.secondary" gutterBottom>
            Convert observability CSV (MicroViSim standard or k6 raw) into calibrated loadSimulation parameters.
          </Typography>
          <Stepper activeStep={activeStep} alternativeLabel sx={{ mt: 2, mb: 1 }}>
            {steps.map((label) => (
              <Step key={label}>
                <StepLabel>{label}</StepLabel>
              </Step>
            ))}
          </Stepper>
        </Grid>
      </Grid>

      <Grid container className={classes.pageBody}>
        <Grid item xs={12} md={activeStep === 2 ? 12 : 8}>
          {errorMsg && (
            <Alert severity="error" sx={{ mb: 2 }} onClose={() => setErrorMsg("")}>
              {errorMsg}
            </Alert>
          )}

          {activeStep === 0 && (
            <>
              <Paper
                variant="outlined"
                sx={{
                  p: 3,
                  mb: 2,
                  textAlign: "center",
                  cursor: "pointer",
                  borderStyle: "dashed",
                  borderColor: file ? "primary.main" : "grey.400",
                  "&:hover": { borderColor: "primary.main", bgcolor: "action.hover" },
                }}
                onClick={() => fileRef.current?.click()}
              >
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) {
                      setFile(f);
                      setMappingHint("");
                    }
                    e.target.value = "";
                  }}
                />
                <UploadFileIcon color={file ? "primary" : "disabled"} sx={{ fontSize: 40, mb: 1 }} />
                <Typography variant="body1" color={file ? "primary.main" : "text.secondary"}>
                  {file ? file.name : "Click to select CSV file"}
                </Typography>
                <Typography variant="caption" color="text.secondary" display="block" mt={1}>
                  Required columns (standard): timestamp, service, endpoint, rps, p50_ms, p95_ms, error_rate, replica_count
                </Typography>
              </Paper>

              <Box sx={{ display: "flex", gap: 1, mb: 2 }}>
                <Button
                  size="small"
                  variant={!isK6 ? "contained" : "outlined"}
                  onClick={() => setIsK6(false)}
                >
                  MicroViSim standard CSV
                </Button>
                <Button
                  size="small"
                  variant={isK6 ? "contained" : "outlined"}
                  onClick={() => setIsK6(true)}
                >
                  k6 raw CSV
                </Button>
              </Box>

              <Accordion disableGutters defaultExpanded={isK6}>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Typography variant="body2" fontWeight={600}>
                    Derivation options (Layer 2)
                  </Typography>
                </AccordionSummary>
                <AccordionDetails>
                  <Grid container spacing={2}>
                    <Grid item xs={12} sm={6}>
                      <TextField
                        label="slotsPerHour"
                        size="small"
                        fullWidth
                        type="number"
                        value={options.slotsPerHour}
                        onChange={(e) => updateOption("slotsPerHour", parseInt(e.target.value, 10) || 1)}
                        helperText="MicroViSim time slots per hour (usually 1)"
                      />
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <TextField
                        label="driftDetectionThresholdMs"
                        size="small"
                        fullWidth
                        type="number"
                        inputProps={{ step: 0.1 }}
                        value={options.driftDetectionThresholdMs}
                        onChange={(e) =>
                          updateOption("driftDetectionThresholdMs", parseFloat(e.target.value) || 2)
                        }
                      />
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <TextField
                        label="lowLoadThresholdPct"
                        size="small"
                        fullWidth
                        type="number"
                        inputProps={{ step: 0.05, min: 0, max: 1 }}
                        value={options.lowLoadThresholdPct}
                        onChange={(e) =>
                          updateOption("lowLoadThresholdPct", parseFloat(e.target.value) || 0.5)
                        }
                        helperText="Fraction of peak RPS used for baseline hours"
                      />
                    </Grid>
                    <Grid item xs={12}>
                      <TextField
                        label="fanOutFactors (JSON)"
                        size="small"
                        fullWidth
                        multiline
                        rows={2}
                        value={options.fanOutFactors}
                        onChange={(e) => updateOption("fanOutFactors", e.target.value)}
                        error={!!jsonErrors.fanOutFactors}
                        helperText={jsonErrors.fanOutFactors || `e.g. {"post-service": 3}`}
                      />
                    </Grid>
                  </Grid>
                </AccordionDetails>
              </Accordion>

              <Accordion disableGutters sx={{ mt: 1 }}>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Typography variant="body2" fontWeight={600}>
                    Search & scoring options (Layer 3)
                  </Typography>
                </AccordionSummary>
                <AccordionDetails>
                  <Grid container spacing={2}>
                    <Grid item xs={12} sm={4}>
                      <TextField
                        label="searchRangePct"
                        size="small"
                        fullWidth
                        type="number"
                        inputProps={{ step: 0.05, min: 0, max: 1 }}
                        value={options.searchRangePct}
                        onChange={(e) =>
                          updateOption("searchRangePct", parseFloat(e.target.value) || 0.3)
                        }
                        helperText="Grid search ± range"
                      />
                    </Grid>
                    <Grid item xs={12} sm={4}>
                      <TextField
                        label="searchSteps"
                        size="small"
                        fullWidth
                        type="number"
                        value={options.searchSteps}
                        onChange={(e) => updateOption("searchSteps", parseInt(e.target.value, 10) || 7)}
                      />
                    </Grid>
                    <Grid item xs={12} sm={4}>
                      <TextField
                        label="spikeRatioThreshold"
                        size="small"
                        fullWidth
                        type="number"
                        inputProps={{ step: 0.1 }}
                        value={options.spikeRatioThreshold}
                        onChange={(e) =>
                          updateOption("spikeRatioThreshold", parseFloat(e.target.value) || 3)
                        }
                      />
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <TextField
                        label="loadCorrelationThreshold"
                        size="small"
                        fullWidth
                        type="number"
                        inputProps={{ step: 0.05, min: 0, max: 1 }}
                        value={options.loadCorrelationThreshold}
                        onChange={(e) =>
                          updateOption("loadCorrelationThreshold", parseFloat(e.target.value) || 0.6)
                        }
                      />
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <TextField
                        label="jitterCvThreshold"
                        size="small"
                        fullWidth
                        type="number"
                        inputProps={{ step: 0.05, min: 0, max: 1 }}
                        value={options.jitterCvThreshold}
                        onChange={(e) =>
                          updateOption("jitterCvThreshold", parseFloat(e.target.value) || 0.2)
                        }
                      />
                    </Grid>
                    <Grid item xs={12} sm={4}>
                      <TextField
                        label="MAPE weight: latency"
                        size="small"
                        fullWidth
                        value={options.mapeWeights.latency}
                        onChange={(e) =>
                          updateOption("mapeWeights", {
                            ...options.mapeWeights,
                            latency: e.target.value,
                          })
                        }
                      />
                    </Grid>
                    <Grid item xs={12} sm={4}>
                      <TextField
                        label="MAPE weight: errorRate"
                        size="small"
                        fullWidth
                        value={options.mapeWeights.errorRate}
                        onChange={(e) =>
                          updateOption("mapeWeights", {
                            ...options.mapeWeights,
                            errorRate: e.target.value,
                          })
                        }
                      />
                    </Grid>
                    <Grid item xs={12} sm={4}>
                      <TextField
                        label="MAPE weight: rps"
                        size="small"
                        fullWidth
                        value={options.mapeWeights.rps}
                        onChange={(e) =>
                          updateOption("mapeWeights", {
                            ...options.mapeWeights,
                            rps: e.target.value,
                          })
                        }
                        error={!!jsonErrors.mapeWeights}
                        helperText={jsonErrors.mapeWeights || "Must sum to 1.0"}
                      />
                    </Grid>
                  </Grid>
                </AccordionDetails>
              </Accordion>

              {isK6 && (
                <Accordion disableGutters defaultExpanded sx={{ mt: 1 }}>
                  <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                    <Typography variant="body2" fontWeight={600}>
                      k6 mapping
                    </Typography>
                  </AccordionSummary>
                  <AccordionDetails>
                    <Button
                      size="small"
                      variant="outlined"
                      disabled={!file}
                      onClick={handleGenerateMapping}
                      sx={{ mb: 1 }}
                    >
                      Generate mapping from CSV
                    </Button>
                    {mappingHint && (
                      <Alert severity="info" sx={{ mb: 2 }}>
                        {mappingHint}
                      </Alert>
                    )}
                    <TextField
                      label="nameMap (JSON)"
                      size="small"
                      fullWidth
                      multiline
                      rows={5}
                      value={nameMap}
                      onChange={(e) => setNameMap(e.target.value)}
                      error={!!jsonErrors.nameMap}
                      helperText={
                        jsonErrors.nameMap ||
                        "Generate from CSV, then edit the service / endpoint labels as needed. Keys must remain the exact k6 name values."
                      }
                      sx={{ mb: 2 }}
                    />
                    <TextField
                      label="replicaCounts (JSON)"
                      size="small"
                      fullWidth
                      multiline
                      rows={2}
                      value={replicaCounts}
                      onChange={(e) => setReplicaCounts(e.target.value)}
                      error={!!jsonErrors.replicaCounts}
                      helperText={jsonErrors.replicaCounts || `e.g. {"auth-service": 2}`}
                    />
                  </AccordionDetails>
                </Accordion>
              )}

              <Box sx={{ display: "flex", gap: 1, mt: 2 }}>
                <Button
                  variant="contained"
                  color="primary"
                  startIcon={<PlayArrowIcon />}
                  disabled={!file || running}
                  onClick={handleRun}
                  sx={{ flex: 1 }}
                >
                  Run Converter
                </Button>
                <Button
                  variant="outlined"
                  color="inherit"
                  startIcon={<RestartAltIcon />}
                  disabled={running}
                  onClick={handleResetConfiguration}
                >
                  Reset configuration
                </Button>
              </Box>
            </>
          )}

          {activeStep === 1 && (
            <Paper variant="outlined" sx={{ p: 4, textAlign: "center" }}>
              <CircularProgress sx={{ mb: 2 }} />
              <Typography variant="body1" gutterBottom>
                Running converter pipeline…
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Extracting metrics → deriving parameters → grid search with MAPE scoring
              </Typography>
              <LinearProgress sx={{ mt: 3 }} />
            </Paper>
          )}

          {activeStep === 2 && result && (
            <>
              <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
                <Typography variant="subtitle1" fontWeight={700} gutterBottom>
                  Summary — {result.summary.endpointCount} endpoints converted
                </Typography>
                <Box sx={{ display: "flex", justifyContent: "center", gap: 2, my: 1 }}>
                  <MapeBadge value={result.summary.meanWeightedMape} label="Mean weighted MAPE" />
                </Box>
                <Divider sx={{ my: 1 }} />
                <Typography variant="caption" color="text.secondary">
                  Delay type distribution:&nbsp;
                  {Object.entries(result.summary.delayTypeDistribution)
                    .filter(([, n]) => n > 0)
                    .map(([t, n]) => `${t}: ${n}`)
                    .join(" · ")}
                </Typography>
              </Paper>

              <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1, mb: 2 }}>
                <TextField
                  size="small"
                  placeholder="Search endpoints…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  InputProps={{
                    startAdornment: (
                      <InputAdornment position="start">
                        <SearchIcon fontSize="small" />
                      </InputAdornment>
                    ),
                  }}
                  sx={{ flex: 1, minWidth: 200 }}
                />
                <TextField
                  size="small"
                  label="namespace"
                  value={namespace}
                  onChange={(e) => setNamespace(e.target.value)}
                  sx={{ width: 120 }}
                />
                <TextField
                  size="small"
                  label="version"
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                  sx={{ width: 100 }}
                />
              </Box>

              {filteredEndpoints.map(([key, ep]) => (
                <Accordion key={key} disableGutters sx={{ mb: 1 }}>
                  <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                    <Box
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 1,
                        flexWrap: "wrap",
                        width: "100%",
                      }}
                    >
                      {ep.mape.weighted < 20 ? (
                        <CheckCircleOutlineIcon color="success" fontSize="small" />
                      ) : (
                        <WarningAmberIcon color="warning" fontSize="small" />
                      )}
                      <Typography variant="body2" fontWeight={600}>
                        {ep.service}
                      </Typography>
                      <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
                        {ep.endpoint}
                      </Typography>
                      <Chip
                        label={`MAPE ${ep.mape.weighted.toFixed(1)}%`}
                        size="small"
                        color={
                          ep.mape.weighted < 20
                            ? "success"
                            : ep.mape.weighted < 50
                              ? "warning"
                              : "error"
                        }
                        variant="outlined"
                      />
                    </Box>
                  </AccordionSummary>
                  <AccordionDetails>
                    <Box sx={{ display: "flex", justifyContent: "space-around", mb: 2 }}>
                      <MapeBadge value={ep.mape.latency} label="Latency" />
                      <MapeBadge value={ep.mape.errorRate} label="Error rate" />
                      <MapeBadge value={ep.mape.rps} label="RPS" />
                    </Box>
                    <Typography variant="caption" color="text.secondary" display="block" mb={0.5}>
                      Selected delay types
                    </Typography>
                    <Box mb={1}>
                      {ep.selectedTypes.map((t) => (
                        <Tooltip key={t} title={ep.selectionReasons[t] ?? ""} arrow>
                          <span>
                            <DelayTypeChip type={t} />
                          </span>
                        </Tooltip>
                      ))}
                    </Box>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>Parameter</TableCell>
                          <TableCell align="right">Value</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        <TableRow>
                          <TableCell>capacityPerReplica</TableCell>
                          <TableCell align="right">{ep.capacityPerReplica} req/s</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell>errorRatePercent</TableCell>
                          <TableCell align="right">{ep.errorRatePercent}%</TableCell>
                        </TableRow>
                        {ep.delays.map((d, i) => (
                          <TableRow key={i}>
                            <TableCell>
                              delay[{i}] <code style={{ fontSize: "0.75em" }}>{d.type}</code>
                            </TableCell>
                            <TableCell align="right">
                              {d.latencyMs}ms / jitter {d.jitterMs}ms
                              {d.driftRate !== undefined &&
                                ` / drift ${d.driftRate}ms (${d.driftMode})`}
                              {d.spikeProbability !== undefined &&
                                ` / prob ${d.spikeProbability} ×${d.spikeMagnitude}`}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </AccordionDetails>
                </Accordion>
              ))}
            </>
          )}
        </Grid>

        {activeStep !== 2 && (
          <Grid item xs={12} md={4}>
            <Paper variant="outlined" sx={{ p: 2, position: "sticky", top: "11em" }}>
              <Typography variant="subtitle2" fontWeight={700} gutterBottom>
                Pipeline overview
              </Typography>
              <Typography variant="body2" color="text.secondary" paragraph>
                1. <strong>MetricsExtractor</strong> — parse CSV into hourly endpoint stats
              </Typography>
              <Typography variant="body2" color="text.secondary" paragraph>
                2. <strong>ParameterDeriver</strong> — estimate latency, capacity, drift from observations
              </Typography>
              <Typography variant="body2" color="text.secondary" paragraph>
                3. <strong>ConverterService</strong> — select delay types and grid-search for lowest MAPE
              </Typography>
              <Divider sx={{ my: 1.5 }} />
              <Typography variant="caption" color="text.secondary">
                Output can be exported as loadSimulation YAML and applied directly to the simulator editor.
              </Typography>
            </Paper>
          </Grid>
        )}

        {activeStep === 2 && result && (
          <Grid item xs={12}>
            <Paper variant="outlined" sx={{ p: 2, mt: 1 }}>
              <Typography variant="subtitle2" fontWeight={700} gutterBottom>
                Export & apply
              </Typography>
              <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
                <Button variant="outlined" startIcon={<DownloadIcon />} onClick={handleDownloadYaml}>
                  Download YAML
                </Button>
                <Button
                  variant={yamlCopied ? "contained" : "outlined"}
                  color={yamlCopied ? "success" : "primary"}
                  startIcon={yamlCopied ? <CheckCircleOutlineIcon /> : <ContentCopyIcon />}
                  onClick={handleCopyYaml}
                  sx={{ transition: "all 180ms ease", transform: yamlCopied ? "scale(1.04)" : "scale(1)" }}
                >
                  {yamlCopied ? "Copied" : "Copy YAML"}
                </Button>
                {standardCsv && (
                  <Button
                    variant="outlined"
                    startIcon={<DownloadIcon />}
                    onClick={handleDownloadStandardCsv}
                  >
                    Download standard CSV
                  </Button>
                )}
                {Config.backendConfig.SimulatorMode && (
                  <Button
                    variant="contained"
                    color="secondary"
                    startIcon={<FlashOnIcon />}
                    onClick={handleApplyToSimulator}
                  >
                    Apply to Simulator
                  </Button>
                )}
                <Button variant="text" startIcon={<RestartAltIcon />} onClick={handleReset}>
                  Start over
                </Button>
              </Box>
              <Box sx={{ mt: 2, border: 1, borderColor: "divider", borderRadius: 1, overflow: "hidden" }}>
                <MonacoEditor
                  value={generatedYaml}
                  language="yaml"
                  theme="light"
                  height="360px"
                  options={{
                    readOnly: true,
                    minimap: { enabled: false },
                    lineNumbers: "on",
                    wordWrap: "on",
                    tabSize: 2,
                  }}
                />
              </Box>
            </Paper>
          </Grid>
        )}
      </Grid>
    </Box>
  );
}
