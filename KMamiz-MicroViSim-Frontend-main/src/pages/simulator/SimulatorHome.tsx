import {
  Card, Grid, Button, Tooltip, TextField, Typography,
} from "@mui/material";
import { makeStyles } from "@mui/styles";
import {
  useState,
  useEffect,
  useRef,
  useCallback,
} from "react";
import SimulationService from "../../services/SimulationService";
import DataService from "../../services/DataService";
import ViewportUtils from "../../classes/ViewportUtils";
import MonacoEditor from "@monaco-editor/react";
import ComparatorService from "../../services/ComparatorService";
import YAML from 'yaml';
import Swal from 'sweetalert2'
import withReactContent from 'sweetalert2-react-content'
import { useNavigate } from "react-router-dom";
import SimulationProgress from "../../components/SimulationProgress";
import { isRunning, TSimulationJobStatus } from "../../entities/TSimulationJob";

const SwalHandler = withReactContent(Swal);
const STATUS_POLL_MS = 1500;
// The YAML of the last successful run, shown when the page opens.
const SAVED_YAML_KEY = 'simulatorYaml';
// The YAML of the run in progress, so a reload shows what is running, not the last success.
const RUNNING_YAML_KEY = 'simulatorRunningYaml';
const splitErrorLines = (message: string) =>
  message.split('\n---\n').map(line => line.trim()).filter(line => line.length > 0);

const useStyles = makeStyles(() => ({
  container: {
    display: 'flex',
    height: '100vh',
    flexDirection: 'row',
  },
  actions: {
    height: "3em",
    display: "flex",
    flexDirection: "row",
    placeItems: "center",
    justifyContent: "center",
    gap: "1em",
    padding: "1em",
  },
  buttonGroups: {
    height: '3em',
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '1em',
    padding: '1em',
    minHeight: '4.2em',
  },
  fullWidthButton: {
    gridColumn: '1 / -1',
  },
  button: {
    textTransform: 'none',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    minHeight: '2em',
  },
  editor: {
    width: '45%',
    padding: '10px',
    borderRight: '5px solid #ccc',
    display: 'flex',
    flexDirection: 'column',
    height: '70vh',
  },
  graphContainer: {
    width: '65%',
    padding: '10px',
    overflow: 'auto',
    height: '100%',
  },
  divider: {
    width: '5px',
    cursor: 'ew-resize',
    backgroundColor: '#ddd',
    height: '100%',
  },
  editorField: {
    resize: 'none',
    width: '100%',
    overflowY: 'auto',
    border: '1px solid black'
  },
  buttonContainer: {
    marginTop: '16px',
  }
}));

export default function SimulatorHome() {
  const classes = useStyles();
  const navigate = useNavigate();

  const [yamlInput, setYamlInput] = useState(() => {
    return "";
  });

  const [loading, setLoading] = useState(false);

  // The latest simulation run, which may have been started from another tab or before a reload.
  const [jobStatus, setJobStatus] = useState<TSimulationJobStatus | null>(null);
  const jobRunning = isRunning(jobStatus);
  // Set from a started run until its own status arrives, so an older status, e.g. the
  // last run's, is never taken for it.
  const awaitingRun = useRef<{ previousStartedAt: number | null } | null>(null);
  const [awaiting, setAwaiting] = useState(false);
  // False until the first status check answers: until then a run may be going unseen.
  const [statusChecked, setStatusChecked] = useState(false);
  const busy = loading || jobRunning || awaiting || !statusChecked;
  const previousJobState = useRef<string | null>(null);
  const submittedYaml = useRef<string | null>(null);
  const latestStatusRequest = useRef(0);

  // create new version tag
  const latestVersionStr = "Latest";
  const [newVersionTagToCreate, setNewVersionTagToCreate] = useState<string>("");
  const [versionTagErrorMessage, setVersionTagErrorMessage] = useState("");
  const [errorLines, setErrorLines] = useState<string[]>([]);

  /***window size control***/
  const rwdWidth = 1200;
  const [isInSmallScreen, setIsInSmallScreen] = useState<boolean>(true);

  // For file input
  const fileInputRef = useRef<HTMLInputElement>(null);

  /***useEffect for window size control***/
  useEffect(() => {
    const unsubscribe = [
      ViewportUtils.getInstance().subscribe(([vw]) => {
        setIsInSmallScreen(vw > rwdWidth ? false : true)
      }),
    ];
    return () => {
      unsubscribe.forEach((un) => un());
    };
  }, []);

  useEffect(() => {
    const savedYaml = localStorage.getItem(SAVED_YAML_KEY);
    if (savedYaml) {
      setYamlInput(savedYaml);
    }
  }, []);

  const refreshJobStatus = useCallback(async () => {
    const request = ++latestStatusRequest.current;
    const status = await SimulationService.getInstance().getSimulationStatus();
    // A later request may have answered first; an older status would step the page back.
    if (request !== latestStatusRequest.current) return;
    if (status) {
      if (awaitingRun.current) {
        const { previousStartedAt } = awaitingRun.current;
        if (status.startedAt === null || status.startedAt === previousStartedAt) return;
        awaitingRun.current = null;
        setAwaiting(false);
      }
      setJobStatus(status);
    }
    // After the status, which React 17 renders separately here: the page must not unlock
    // before it knows whether a run is going. Unlocks even when the backend cannot be
    // reached; starting then says why.
    setStatusChecked(true);
  }, []);

  useEffect(() => {
    refreshJobStatus();
  }, [refreshJobStatus]);

  // Each poll waits for the last: while the backend is busy computing, it answers late,
  // and overlapping polls would pile up.
  const polling = jobRunning || awaiting;
  useEffect(() => {
    if (!polling) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refreshJobStatus();
      if (!stopped) timer = setTimeout(poll, STATUS_POLL_MS);
    };
    timer = setTimeout(poll, STATUS_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [polling, refreshJobStatus]);

  // After a reload, show the YAML of the run that was submitted last instead of the last
  // successful one, and finish what the page that submitted it could not.
  const restoredRunningYaml = useRef(false);
  useEffect(() => {
    if (!statusChecked || restoredRunningYaml.current) return;
    restoredRunningYaml.current = true;
    const runningYaml = localStorage.getItem(RUNNING_YAML_KEY);
    if (!runningYaml) return;

    setYamlInput(runningYaml);
    submittedYaml.current = runningYaml;
    // Still going, its end is handled below; unknown, the backend may be down.
    if (jobRunning || !jobStatus) return;
    if (jobStatus?.state === "succeeded") localStorage.setItem(SAVED_YAML_KEY, runningYaml);
    localStorage.removeItem(RUNNING_YAML_KEY);
  }, [statusChecked]);

  // Tell the user how a run they watched ended.
  useEffect(() => {
    const state = jobStatus?.state ?? null;
    const was = previousJobState.current;
    previousJobState.current = state;
    if (was !== "running" && was !== "cancelling") return;
    if (state !== "running" && state !== "cancelling") localStorage.removeItem(RUNNING_YAML_KEY);

    if (state === "succeeded") {
      if (submittedYaml.current) localStorage.setItem(SAVED_YAML_KEY, submittedYaml.current);
      setErrorLines([]);
      SwalHandler.fire({
        icon: 'success',
        title: 'Simulation completed',
        text: jobStatus?.warnings.length ? 'Completed with warnings; see the progress panel.' : undefined,
        showCancelButton: true,
        confirmButtonText: 'Open Metrics',
        cancelButtonText: 'Close',
      }).then(result => { if (result.isConfirmed) navigate("/metrics"); });
    } else if (state === "failed") {
      const lines = splitErrorLines(jobStatus?.error ?? "Unknown error.");
      setErrorLines(lines);
      SwalHandler.fire({ icon: 'error', title: 'Simulation failed', text: lines[0] });
    } else if (state === "cancelled") {
      SwalHandler.fire({ icon: 'info', title: 'Simulation cancelled' });
    }
  }, [jobStatus?.state, jobStatus?.startedAt]);

  const handleStartSimulateClick = async () => {
    if (!yamlInput) {
      return;
    }

    try {
      YAML.parse(yamlInput);
    } catch (err) {
      await SwalHandler.fire({
        icon: 'error',
        title: 'Invalid YAML Format',
        text: String(err),
      });
      return;
    }

    setLoading(true);
    setErrorLines([]);
    try {
      const { started, alreadyRunning, message } = await SimulationService.getInstance().startSimulation(yamlInput);
      if (started) {
        submittedYaml.current = yamlInput;
        localStorage.setItem(RUNNING_YAML_KEY, yamlInput);
        awaitingRun.current = { previousStartedAt: jobStatus?.startedAt ?? null };
        setAwaiting(true);
        // Even a run that ends before the first poll counts as watched.
        previousJobState.current = "running";
      } else if (alreadyRunning) {
        await SwalHandler.fire({ icon: 'warning', title: 'Simulation already running', text: message });
      } else {
        setErrorLines(splitErrorLines(message));
        console.error(message);
      }
      await refreshJobStatus();
    } finally {
      setLoading(false);
    }
  };

  const handleCancelSimulationClick = async () => {
    const result = await SwalHandler.fire({
      icon: 'warning',
      title: 'Cancel the simulation?',
      text: 'Model training stops as well. Data from earlier runs was already cleared when this run started.',
      showCancelButton: true,
      confirmButtonText: 'Cancel Simulation',
      confirmButtonColor: '#d33',
      cancelButtonText: 'Keep Running',
    });
    if (!result.isConfirmed) return;

    const { accepted, message } = await SimulationService.getInstance().cancelSimulation();
    if (!accepted) {
      await SwalHandler.fire({ icon: 'error', title: 'Could not cancel', text: message });
    }
    await refreshJobStatus();
  };

  const handleGenerateYamlClick = async () => {
    if (!yamlInput) {
      await fetchStaticYamlStr();
    } else {
      const result = await SwalHandler.fire({
        icon: 'warning',
        title: 'This action cannot be undone. Are you sure you want to proceed?',
        text: 'After confirmation, the YAML content in the editor will be overwritten.',
        showCancelButton: true,
        confirmButtonText: 'Confirm',
        confirmButtonColor: '#d33',
        cancelButtonText: 'Cancel',
      });

      if (result.isConfirmed) {
        await fetchStaticYamlStr();
      } else {
        return;
      }
    }
  };

  const handleCloneDataClick = async () => {
    const result = await SwalHandler.fire({
      icon: 'warning',
      title: 'This action cannot be undone. Are you sure you want to proceed?',
      html: `
        The simulator will clone data from the KMamiz, and 
         <strong style="color: red;">all existing data in the simulator will be overwritten!</strong><br />
      `,
      showCancelButton: true,
      confirmButtonText: 'Confirm',
      confirmButtonColor: '#d33',
      cancelButtonText: 'Cancel',
    });

    if (!result.isConfirmed) {
      return;
    }
    setLoading(true);

    try {
      await SwalHandler.fire({
        title: <p>Cloning data...</p>,
        didOpen: () => {
          SwalHandler.showLoading();
        },
        allowOutsideClick: false,
        allowEscapeKey: false,
        showConfirmButton: false,
        backdrop: true,
        didRender: async () => {
          const { isSuccess, message } =
            await DataService.getInstance().cloneDataFromProductionService();

          if (isSuccess) {
            await SwalHandler.fire({
              icon: 'success',
              title: 'Success',
            });
          } else {
            await SwalHandler.fire({
              icon: 'error',
              title: 'Failed',
              text: message,
            });
          }
        },
      });
    } catch (error) {
      console.error('Error during cloning process:', error);
      await SwalHandler.fire({
        icon: 'error',
        title: 'Unexpected Error',
        text: `An unexpected error occurred while creating the version: ${error}`,
      });
    } finally {
      setLoading(false);
    }
  };

  const fetchStaticYamlStr = async () => {
    setLoading(true);
    try {
      const { staticYamlStr, message } = await SimulationService.getInstance().generateSimConfigFromCurrentStaticData();

      if (message !== 'ok') {
        await SwalHandler.fire({
          icon: 'error',
          title: 'Error',
          text: message,
        });
        console.error(message);
      } else {
        setYamlInput(staticYamlStr);
        await SwalHandler.fire({
          icon: 'success',
          title: 'Success',
        });
      }
    } finally {
      setLoading(false);
    }
  };

  const handleEditorChange = (value: string | undefined) => {
    setYamlInput(value || "");
  };
  const createNewVersion = async () => {
    if (!newVersionTagToCreate) return;
    if (newVersionTagToCreate == latestVersionStr) {
      setNewVersionTagToCreate("");
      setVersionTagErrorMessage(`Version name cannot be set to "${latestVersionStr}"`);
      return;
    }
    setLoading(true);
    try {
      await SwalHandler.fire({
        title: 'Creating new version...',
        didOpen: () => {
          SwalHandler.showLoading();
        },
        allowOutsideClick: false,
        allowEscapeKey: false,
        showConfirmButton: false,
        backdrop: true,
        didRender: async () => {
          const isSuccess = await ComparatorService.getInstance().addTaggedDiffData(newVersionTagToCreate);

          if (isSuccess) {
            await SwalHandler.fire({
              icon: 'success',
              title: 'Version Created!',
              html: `In the comparator, you can view the system architecture of version <strong style="color: blue;">"[from Simulator] ${newVersionTagToCreate}"</strong>. `
            });
            setNewVersionTagToCreate("");
          } else {
            await SwalHandler.fire({
              icon: 'error',
              title: 'Failed',
              text: `Failed to create version`,
            });
          }
        },
      });

    } catch (error) {
      await SwalHandler.fire({
        icon: 'error',
        title: 'An unexpected error occurred',
        text: `Something went wrong while creating the version: ${error}`,
      });
    } finally {
      setLoading(false);
    };
  };

  const ErrorMessageCard = ({ height }: { height: string }) => (
    <Card
      variant="outlined"
      style={{
        padding: 16,
        backgroundColor: "#fee",
        height,
        overflowY: 'auto',
        overflowX: 'auto',
        boxSizing: 'border-box',
      }}
    >
      <Typography variant="h6" color="error" gutterBottom>
        {errorLines[0]} {/* Use the first line of the error message as the title */}
      </Typography>
      {errorLines.length > 1 && (
        <ul>
          {errorLines.slice(1).map((line, idx) => (
            <li key={idx}>
              <Typography variant="body2" color="error">{line}</Typography>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );

  const handleUploadDatasetClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // 清空 input，讓同一個檔案可以重複上傳
    e.target.value = "";

    const result = await SwalHandler.fire({
      icon: 'warning',
      title: 'Upload training dataset?',
      text: `File: ${file.name}`,
      showCancelButton: true,
      confirmButtonText: 'Confirm',
      confirmButtonColor: '#d33',
      cancelButtonText: 'Cancel',
    });

    if (!result.isConfirmed) return;

    setLoading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);

      // 替換成你實際的 API endpoint
      const { isSuccess, message } = await SimulationService.getInstance().uploadTrainingDataset(formData);

      if (isSuccess) {
        await SwalHandler.fire({ icon: 'success', title: 'Upload successful!' });
      } else {
        await SwalHandler.fire({ icon: 'error', title: 'Upload failed', text: message });
      }
    } catch (error) {
      await SwalHandler.fire({ icon: 'error', title: 'Unexpected Error', text: String(error) });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={classes.container}>
      <div
        className={classes.editor}
        style={{ width: `100%` }}
      >
        <Grid container spacing={2}>
          <Grid item xs={isInSmallScreen ? 12 : 6} justifyContent="center" alignItems="center">
            <Card variant="outlined" className={classes.buttonGroups}>
              <Button
                variant="contained"
                color="primary"
                onClick={handleStartSimulateClick}
                disabled={busy || !yamlInput}
                className={`${classes.button} ${classes.fullWidthButton}`}
              >
                {!statusChecked
                  ? 'Checking simulation status...'
                  : jobRunning || awaiting ? 'Simulation running...' : loading ? 'Loading...' : 'Start Simulation'}
              </Button>
              <Button
                variant="contained"
                color="secondary"
                onClick={handleGenerateYamlClick}
                disabled={busy}
                className={classes.button}
              >
                {loading ? 'Loading...' : 'Generate YAML from Simulator Data'}
              </Button>
              <Button
                variant="contained"
                color="error"
                onClick={handleCloneDataClick}
                disabled={busy}
                className={classes.button}
              >
                {loading ? 'Loading...' : 'Clone Data from KMamiz '}
              </Button>
              <Button
                variant="contained"
                color="success"
                onClick={handleUploadDatasetClick}
                disabled={busy}
                className={classes.button}
              >
                {loading ? 'Loading...' : 'Upload Training Dataset'}
              </Button>
              <Button
                variant="contained"
                onClick={() => navigate("/converter")}
                disabled={busy}
                className={classes.button}
                sx={{ background: "linear-gradient(90deg, #1565c0, #6a1b9a)", color: "#fff" }}
              >
                {loading ? 'Loading...' : 'Open Converter'}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.json"
                style={{ display: 'none' }}
                onChange={handleFileChange}
              />

              {/* <Button
                variant="contained"
                color="error"
                onClick={handleGenerateExampleYamlClick}
                disabled={busy}
                className={classes.button}
              >
                {loading ? 'Loading...' : 'Use Example YAML'}
              </Button> */}
              {/* <Button
                variant="contained"
                color="success"
                disabled={busy}
                className={classes.button}
              >
                {loading ? 'Loading...' : 'Export Simulation Report'}
              </Button> */}
            </Card>
          </Grid>
          <Grid item xs={isInSmallScreen ? 12 : 6}>
            <Card variant="outlined" className={classes.actions}>
              <TextField
                id="new-version-tag"
                fullWidth
                label="Save simulator data as a new version for the comparator."
                variant="outlined"
                value={newVersionTagToCreate}
                onChange={(e) => setNewVersionTagToCreate(e.target.value)}
                error={!!versionTagErrorMessage}
                helperText={versionTagErrorMessage}
              />
              <Tooltip title="Save simulator data as a new version for the comparator.">
                <Button
                  variant="contained"
                  onClick={() => createNewVersion()}
                  disabled={!newVersionTagToCreate || busy}

                >
                  {loading ? 'Loading...' : 'Create'}
                </Button>
              </Tooltip>
            </Card>
          </Grid>
          {jobStatus && jobStatus.state !== "idle" && (
            <Grid item xs={12}>
              <SimulationProgress status={jobStatus} onCancel={handleCancelSimulationClick} />
            </Grid>
          )}
          {isInSmallScreen && errorLines.length > 0 && (
            <Grid item xs={12}>
              <ErrorMessageCard height="20vh" />
            </Grid>
          )}
          <Grid item xs={isInSmallScreen ? 12 : errorLines.length > 0 ? 8 : 12}>
            <MonacoEditor
              className={classes.editorField}
              value={yamlInput}
              onChange={handleEditorChange}
              language="yaml"
              theme="light"
              height={!isInSmallScreen
                ? "75vh"
                : errorLines.length > 0
                  ? "45vh"
                  : "65vh"}
              options={{
                // Until the status is known the YAML of a running run may still replace it.
                readOnly: !statusChecked,
                minimap: { enabled: false },
                lineNumbers: "on",
                wordWrap: "on",
                tabSize: 2,
                autoIndent: "advanced",
                formatOnType: true,
                suggestOnTriggerCharacters: true,
              }}
            />
          </Grid>
          {!isInSmallScreen && errorLines.length > 0 && (
            <Grid item xs={4}>
              <ErrorMessageCard height="75vh" />
            </Grid>
          )}
        </Grid>

      </div>
    </div>
  );
}