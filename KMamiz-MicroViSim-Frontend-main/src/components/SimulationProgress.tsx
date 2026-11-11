import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CircularProgress,
  LinearProgress,
  Step,
  StepLabel,
  Stepper,
  Typography,
} from "@mui/material";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import CancelIcon from "@mui/icons-material/Cancel";
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";
import RemoveCircleOutlineIcon from "@mui/icons-material/RemoveCircleOutline";
import {
  isRunning,
  TrainingSteps,
  TSimulationJobStatus,
  TSimulationStage,
  TStageStatus,
  TTrainingProgress,
} from "../entities/TSimulationJob";

const STAGE_LABELS: Record<TSimulationStage, string> = {
  validating: "Validate config",
  simulatingTraffic: "Simulate traffic",
  trainingModels: "Train models",
  simulatingLoadEffects: "Simulate load effects",
  generatingMetrics: "Generate metrics",
  saving: "Save results",
};

function StageIcon({ status }: { status: TStageStatus }) {
  switch (status) {
    case "active": return <CircularProgress size={22} />;
    case "done": return <CheckCircleIcon color="success" />;
    case "failed": return <ErrorIcon color="error" />;
    case "cancelled": return <CancelIcon color="warning" />;
    case "skipped": return <RemoveCircleOutlineIcon color="disabled" />;
    default: return <RadioButtonUncheckedIcon color="disabled" />;
  }
}

// "name\tnamespace\tversion" -> "name.namespace (version)"
const serviceLabel = (uniqueServiceName: string) => {
  const [name, namespace, version] = uniqueServiceName.split("\t");
  return version ? `${name}.${namespace} (${version})` : uniqueServiceName;
};

const formatDuration = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;
};

// Services done plus the finished share of the current one's steps.
const trainingPercent = (training: TTrainingProgress) => {
  if (training.total === 0) return 0;
  const stepIndex = training.step ? Math.max(TrainingSteps.indexOf(training.step), 0) : 0;
  const current = training.done < training.total ? stepIndex / TrainingSteps.length : 0;
  return Math.min(100, ((training.done + current) / training.total) * 100);
};

/*
  Where a simulation run is: its stages, the model training under way, how long it has
  taken, and how it ended. Cancelling also stops the ML service's training.
*/
export default function SimulationProgress({
  status,
  onCancel,
}: {
  status: TSimulationJobStatus;
  onCancel: () => void;
}) {
  const running = isRunning(status);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const elapsed = status.startedAt ? (status.finishedAt ?? now) - status.startedAt : 0;
  const activeStage = status.stages.find(s => s.status === "active")?.stage;
  const failedStage = status.stages.find(s => s.status === "failed")?.stage;
  const training = status.training;

  return (
    <Card variant="outlined" style={{ padding: 16 }}>
      <Box style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <Typography variant="h6">
          {running
            ? status.state === "cancelling" ? "Cancelling simulation..." : "Simulation running"
            : status.state === "succeeded" ? "Simulation completed"
              : status.state === "failed" ? "Simulation failed"
                : "Simulation cancelled"}
          <Typography component="span" variant="body2" color="text.secondary" style={{ marginLeft: 12 }}>
            {running ? "elapsed" : "took"} {formatDuration(elapsed)}
          </Typography>
        </Typography>
        {running && (
          <Button
            variant="outlined"
            color="error"
            onClick={onCancel}
            disabled={!status.cancellable}
            title={status.cancellable ? "" : "Results are being saved and can no longer be cancelled."}
          >
            {status.state === "cancelling" ? "Cancelling..." : "Cancel Simulation"}
          </Button>
        )}
      </Box>

      <Stepper alternativeLabel>
        {status.stages.map(({ stage, status: stageStatus }) => (
          <Step key={stage} completed={stageStatus === "done"} active={stageStatus === "active"}>
            <StepLabel
              icon={<StageIcon status={stageStatus} />}
              error={stageStatus === "failed"}
              optional={stageStatus === "skipped"
                ? <Typography variant="caption" color="text.secondary">skipped</Typography>
                : undefined}
            >
              {STAGE_LABELS[stage]}
            </StepLabel>
          </Step>
        ))}
      </Stepper>

      {running && activeStage && (
        <Box style={{ marginTop: 16 }}>
          <Typography variant="body2">
            {STAGE_LABELS[activeStage]}{status.detail ? `: ${status.detail}` : ""}
          </Typography>
          {activeStage === "trainingModels" && (
            <Box style={{ marginTop: 8 }}>
              <LinearProgress
                variant={training ? "determinate" : "indeterminate"}
                value={training ? trainingPercent(training) : undefined}
              />
              <Typography variant="caption" color="text.secondary">
                {training
                  ? `${training.done}/${training.total} service(s) trained`
                    + (training.service && training.done < training.total
                      ? ` - now ${serviceLabel(training.service)} (${training.model}): ${training.step ?? "preparing"}`
                      : "")
                  : "Preparing training data... Models are trained once per setting and reused afterwards."}
              </Typography>
            </Box>
          )}
        </Box>
      )}

      {status.state === "failed" && (
        <Alert severity="error" style={{ marginTop: 16, whiteSpace: "pre-wrap" }}>
          {failedStage ? `Failed while "${STAGE_LABELS[failedStage]}". ` : ""}
          {(status.error ?? "Unknown error.").split("\n---\n")[0]}
          {(status.error ?? "").includes("\n---\n") ? " (see the details beside the editor)" : ""}
        </Alert>
      )}
      {status.state === "cancelled" && (
        <Alert severity="info" style={{ marginTop: 16 }}>
          The simulation was cancelled, and so was any model training. Data from earlier runs was
          cleared when this run started.
        </Alert>
      )}
      {status.warnings.length > 0 && (
        <Alert severity="warning" style={{ marginTop: 16 }}>
          {status.warnings.map((w, i) => <div key={i}>{w}</div>)}
        </Alert>
      )}
    </Card>
  );
}
