import { makeStyles } from "@mui/styles";
import {
  useEffect, useMemo, useState,
} from "react";
import {
  Box, Card, Button, Grid, Tooltip, TextField, Typography, FormControl,
  MenuItem, Select, InputLabel,
} from "@mui/material";
import KeyboardDoubleArrowUpIcon from '@mui/icons-material/KeyboardDoubleArrowUp';
import KeyboardDoubleArrowDownIcon from '@mui/icons-material/KeyboardDoubleArrowDown';
import ComparatorService from "../../services/ComparatorService";
import { useLocation, useNavigate } from "react-router-dom";
import DiffDisplay from "../../components/comparator/DiffDisplay";
import Swal from 'sweetalert2'
import withReactContent from 'sweetalert2-react-content'

const SwalHandler = withReactContent(Swal);

type MultiLevelMap = {
  [olderVersionTag: string]: {
    [newerVersionTag: string]: {};
  };
};

const useStyles = makeStyles(() => ({
  root: {
    width: "100%",
    overflowX: "clip",
    marginBottom: "5em",
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
  graphContainer: {
    border: '0.08em solid #ccc',
    boxShadow: '0.4em 0em 0.5em rgba(0, 0, 0, 0.1)',
    float: 'left',
  },
  graphTitle: {
    fontWeight: 'normal',
  },
  graphHeader: {
    borderBottom: '0.08em solid #ccc',
    boxShadow: '0.0em  0.4em 0.5em rgba(0, 0, 0, 0.1)',
    paddingLeft: '0.5em',
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
  switch: {
    paddingLeft: "0.8em",
  },
  graphMessage: {
    textAlign: 'center',
    color: 'gray',
    marginTop: '0.08em',
    width: '100%',
    height: '0.01em',
  }
}));

export default function ComparatorHome() {
  const classes = useStyles();
  const navigate = useNavigate();
  const { search } = useLocation();
  const query = useMemo(() => new URLSearchParams(search), [search]);

  // select version tag
  const currentVersionStr = "Current Version";
  const [tagSelectionMap, setTagSelectionMap] = useState<MultiLevelMap>();
  const [newerVersionTag, setNewerVersionTag] = useState<string>("");
  const [olderVersionTag, setOlderVersionTag] = useState<string>("");
  const [uniqueLabelName, setUniqueLabelName] = useState<string>("");
  const [showPageHeader, setShowPageHeader] = useState(true);

  // create new version tag
  const [newVersionTagToCreate, setNewVersionTagToCreate] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState("");

  /***useEffects for tag control***/
  useEffect(() => {
    const q = query.get("q");
    if (q) {
      const [olderVersionTag, newerVersionTag] = decodeURIComponent(atob(q)).split("\t");
      setOlderVersionTag(olderVersionTag || "");
      setNewerVersionTag(newerVersionTag || "");
    }
  }, []);

  useEffect(() => {
    const next = (nextData?: { tag: string; time: number }[]) => {
      if (nextData) {
        const newTagSelectionMap: MultiLevelMap = {};
        nextData.push({ tag: currentVersionStr, time: -1 });
        const sortedTags = nextData.sort((a, b) => { // sort descending by time and put the current version tag at the top 
          if (a.tag === currentVersionStr) return -1;
          if (b.tag === currentVersionStr) return 1;
          return a.time - b.time;
        });

        sortedTags.forEach((tagI) => {
          const tempOlderVersionTag = JSON.stringify(tagI);
          newTagSelectionMap[tempOlderVersionTag] = { [JSON.stringify({ tag: currentVersionStr, time: -1 })]: {} }
          sortedTags.forEach((tagJ) => {
            const tempNewerVersionTag = JSON.stringify(tagJ);
            newTagSelectionMap[tempOlderVersionTag][tempNewerVersionTag] = {};
          });
        });
        setTagSelectionMap(newTagSelectionMap);
      }
    };

    const unSub = ComparatorService.getInstance().subscribeToDiffdataTags(next);
    return () => {
      unSub();
    };
  }, []);

  useEffect(() => {
    if (newerVersionTag) {
      setUniqueLabelName(
        `${olderVersionTag}\t${newerVersionTag}`
      );
    } else setUniqueLabelName("");
  }, [newerVersionTag]);
  useEffect(() => {
    const url = `${olderVersionTag}${newerVersionTag && `\t${newerVersionTag}`}`;
    const encoded = btoa(encodeURIComponent(url));
    navigate(`/comparatorHome${encoded && `?q=${encoded}`}`, {
      replace: true,
    });
  }, [olderVersionTag, newerVersionTag]);


  /***constants for tag select control***/
  const getMenuItemLevel = (level: number) => {
    if (!tagSelectionMap) return [];
    const keys = [olderVersionTag, newerVersionTag];
    let root = tagSelectionMap;
    for (let i = 0; i < level; i++) {
      if (!root) break;
      for (const key in root) {
        if (JSON.parse(key).tag == keys[i]) {
          root = root[key];
        }
      }
    }
    return root ? Object.keys(root) : [];
  };
  const setAndClearUpTo = (value: string, level: number) => {
    const setFunctions = [
      setOlderVersionTag,
      setNewerVersionTag,
    ];
    setFunctions.forEach((f, id) => {
      if (id > level) {
        f("");
      } else if (id === level) {
        f(value);
      }
    });
  };
  const selects = [
    { name: "Select the 1st vertion", relVal: () => olderVersionTag },
    { name: "Select the 2nd version", relVal: () => newerVersionTag },
  ];
  const desplayFormattedCreateTime = (timestamp: number): string => {
    if (!timestamp) {
      return "";
    } else if (timestamp === -1) { // current version
      return "(Auto)";
    }
    const formatedTimestamp = new Date(timestamp).toLocaleString();
    return `(Created at ${formatedTimestamp})`
  };
  /***constants for diff version control***/
  const createNewVersion = async () => {
    if (!newVersionTagToCreate) return;
    if (newVersionTagToCreate == currentVersionStr) {
      await SwalHandler.fire({
        icon: 'error',
        title: 'Invalid Version Name',
        text: `Version name cannot be set to "${currentVersionStr}"`,
      });
      setNewVersionTagToCreate("");
      return;
    }
    try {
      await SwalHandler.fire({
        title: 'Processing...',
        didOpen: () => {
          SwalHandler.showLoading();
        },
        allowOutsideClick: false,
        allowEscapeKey: false,
        showConfirmButton: false,
        backdrop: true,
        didRender: async () => {
          await ComparatorService.getInstance().addTaggedDiffData(newVersionTagToCreate);

          SwalHandler.fire({
            icon: 'success',
            title: 'Version Created',
            showConfirmButton: true,
          }).then((result) => {
            if (result.isConfirmed) {
              setNewVersionTagToCreate("");
              window.location.replace("/comparatorHome");
            }
          });
        },
      });
    } catch (error) {
      await SwalHandler.fire({
        icon: 'error',
        title: 'Unexpected Error',
        text: `An unexpected error occurred: ${error}`,
      });
    }

  };
  const deleteVersion = async (level: number) => {
    const tagToDelete = level === 0 ? olderVersionTag : level === 1 ? newerVersionTag : "";
    if (!tagToDelete || tagToDelete === currentVersionStr) return;

    const result = await SwalHandler.fire({
      icon: 'warning',
      title: 'This action cannot be undone. Are you sure you want to proceed?',
      html: `
          The data for version <strong style="color: red;">${tagToDelete}</strong> will be deleted.
      `,
      showCancelButton: true,
      confirmButtonText: 'Confirm',
      confirmButtonColor: '#d33',
      cancelButtonText: 'Cancel',
    });
    if (!result.isConfirmed) {
      return;
    }
    try {
      await SwalHandler.fire({
        title: 'Processing...',
        didOpen: () => {
          SwalHandler.showLoading();
        },
        allowOutsideClick: false,
        allowEscapeKey: false,
        showConfirmButton: false,
        backdrop: true,
        didRender: async () => {
          const isSuccess = await ComparatorService.getInstance().deleteTaggedDiffData(tagToDelete);

          if (isSuccess) {
            await SwalHandler.fire({
              icon: 'success',
              title: 'Success',
              showConfirmButton: true,
            });
            window.location.replace("/comparatorHome");
          } else {
            await SwalHandler.fire({
              icon: 'error',
              title: 'Failed',
              text: `Failed to delete the version "${tagToDelete}". Please try again.`,
            });
          }
        },
      });
    } catch (error) {
      await SwalHandler.fire({
        icon: 'error',
        title: 'Unexpected Error',
        text: `An unexpected error occurred: ${error}`,
      });
    }


  };
  const shouldDisableDeleteButton = (level: number): boolean => {
    const tagToDelete = level === 0 ? olderVersionTag : level === 1 ? newerVersionTag : "";
    return (!tagToDelete || tagToDelete === currentVersionStr)

  };



  return (
    <Box className={classes.root}>
      <Grid container padding={showPageHeader ? 1 : 0} spacing={0.5} className={classes.pageHeader}>
        {showPageHeader &&
          <Grid item xs={5}>
            <Typography variant="h5">Comparator</Typography>
          </Grid>
        }
        {showPageHeader &&
          <Grid item xs={7}>
            <Card variant="outlined" className={classes.actions}>
              <TextField
                id="new-version-tag"
                fullWidth
                label="New Version"
                variant="outlined"
                value={newVersionTagToCreate}
                onChange={(e) => setNewVersionTagToCreate(e.target.value)}
                error={!!errorMessage}
                helperText={errorMessage}
              />
              <Tooltip title="New Version">
                <Button
                  variant="contained"
                  onClick={() => createNewVersion()}
                  disabled={!newVersionTagToCreate}
                >
                  Create
                </Button>
              </Tooltip>
            </Card>
          </Grid>
        }
        {showPageHeader && tagSelectionMap &&
          selects.map((s, id) => (
            <Grid item xs={12 / selects.length}>
              <Card variant="outlined" className={classes.actions}>
                <FormControl key={`select-${id}`} fullWidth>
                  <InputLabel id={`label-${id}`}>{s.name}</InputLabel>
                  <Select
                    labelId={`label-${id}`}
                    label={s.name}
                    onChange={(e) => setAndClearUpTo(e.target.value, id)}
                    value={s.relVal()}
                  >
                    {
                      getMenuItemLevel(id).map((val, idx) => {
                        const parsedVal = JSON.parse(val);
                        return (
                          <MenuItem
                            value={parsedVal.tag}
                            key={`${id}-${idx}`}
                            sx={{
                              fontWeight: parsedVal.tag === currentVersionStr ? 'bold' : '',
                              color: parsedVal.tag === currentVersionStr ? 'blue' : '',
                            }}
                          >
                            <div style={{ display: "flex", justifyContent: "space-between", width: "100%" }}>
                              <span>{parsedVal.tag}</span>
                              <span style={{ color: "gray", marginLeft: "0.5em" }}>
                                {desplayFormattedCreateTime(parsedVal.time)}
                              </span>
                            </div>
                          </MenuItem>
                        )
                      }
                      )}
                  </Select>
                </FormControl>
                <Tooltip title="Delete selected">
                  <>
                    <Button
                      variant="contained"
                      color="error"
                      onClick={() => deleteVersion(id)}
                      disabled={shouldDisableDeleteButton(id)}
                    >
                      Delete
                    </Button>
                  </>
                </Tooltip>
              </Card>
            </Grid>
          )
          )}
        <Grid item xs={12}>
          <Button
            variant="contained"
            onClick={() => setShowPageHeader(!showPageHeader)}
            fullWidth
            startIcon={showPageHeader ? <KeyboardDoubleArrowUpIcon /> : <KeyboardDoubleArrowDownIcon />}
            style={{
              backgroundColor: 'lightgray',
              color: 'black',
            }}
          >
          </Button>
        </Grid>
      </Grid>


      <Grid container padding={1} spacing={1} style={{ marginTop: showPageHeader ? '14.5em' : '2em' }}>
        {uniqueLabelName && (
          <DiffDisplay olderVersionTag={olderVersionTag} newerVersionTag={newerVersionTag} currentVersionStr={currentVersionStr} />
        )}
      </Grid>
    </Box>
  );

}
