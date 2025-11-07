import {
  Card, Grid, Button, Tooltip, TextField, Typography,
} from "@mui/material";
import { makeStyles } from "@mui/styles";
import {
  useState,
  useEffect,
} from "react";
import SimulationService from "../../services/SimulationService";
import DataService from "../../services/DataService";
import ViewportUtils from "../../classes/ViewportUtils";
import MonacoEditor from "@monaco-editor/react";
import ComparatorService from "../../services/ComparatorService";
import YAML from 'yaml';
import Swal from 'sweetalert2'
import withReactContent from 'sweetalert2-react-content'

const SwalHandler = withReactContent(Swal);

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
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: '1em',
    padding: '1em',
    minHeight: '4.2em',
  },
  fullWidthButton: {
    gridColumn: 'span 2',
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

  const [yamlInput, setYamlInput] = useState(() => {
    return "";
  });

  const [loading, setLoading] = useState(false);

  // create new version tag
  const latestVersionStr = "Latest";
  const [newVersionTagToCreate, setNewVersionTagToCreate] = useState<string>("");
  const [versionTagErrorMessage, setVersionTagErrorMessage] = useState("");
  const [errorLines, setErrorLines] = useState<string[]>([]);

  /***window size control***/
  const rwdWidth = 1200;
  const [isInSmallScreen, setIsInSmallScreen] = useState<boolean>(true);

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
    const savedYaml = localStorage.getItem('simulatorYaml');
    if (savedYaml) {
      setYamlInput(savedYaml);
    }
  }, []);

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
    
    // console.log(`handleStartSimulateClick 開始計算總執行時間`);
    // const startTime = performance.now();
    setLoading(true);
    setErrorLines([]);
    try {
      const { message, resStatus } = await SimulationService.getInstance().retrieveDataBySimulateYaml(yamlInput);

      if (resStatus >= 400) {
        const lines = message.split('\n---\n').map(line => line.trim()).filter(line => line.length > 0);

        setErrorLines(lines);
        console.error(`${message}`)
      } else {
        localStorage.setItem('simulatorYaml', yamlInput);
        // setYamlInput("");
        setErrorLines([]);
        await SwalHandler.fire({
          icon: 'success',
          title: 'Success',
          text: 'Simulation completed successfully!',
        });
      }
    } finally {
      setLoading(false);
      // const endTime = performance.now(); // 結束時間
      // const duration = endTime - startTime;
      // console.log(`handleStartSimulateClick 總執行時間: ${duration.toFixed(2)} 毫秒`);
    }
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
                disabled={loading || !yamlInput}
                className={`${classes.button} ${classes.fullWidthButton}`}
              >
                {loading ? 'Loading...' : 'Start Simulation'}
              </Button>
              <Button
                variant="contained"
                color="secondary"
                onClick={handleGenerateYamlClick}
                disabled={loading}
                className={classes.button}
              >
                {loading ? 'Loading...' : 'Generate YAML from Simulator Data'}
              </Button>
              <Button
                variant="contained"
                color="error"
                onClick={handleCloneDataClick}
                disabled={loading}
                className={classes.button}
              >
                {loading ? 'Loading...' : 'Clone Data from KMamiz '}
              </Button>
              {/* <Button
                variant="contained"
                color="error"
                onClick={handleGenerateExampleYamlClick}
                disabled={loading}
                className={classes.button}
              >
                {loading ? 'Loading...' : 'Use Example YAML'}
              </Button> */}
              {/* <Button
                variant="contained"
                color="success"
                disabled={loading}
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
                  disabled={!newVersionTagToCreate || loading}

                >
                  {loading ? 'Loading...' : 'Create'}
                </Button>
              </Tooltip>
            </Card>
          </Grid>
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