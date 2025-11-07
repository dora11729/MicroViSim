import {
  Card, FormControlLabel, FormGroup, Switch, Grid, Typography, Box, Tooltip
  , List, ListItem, ListItemIcon, ListItemText,
} from "@mui/material";
import { makeStyles } from "@mui/styles";
import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import ViewportUtils from "../../classes/ViewportUtils";
import ReactApexChart from "react-apexcharts";
import BarChartUtils from "../../classes/BarChartUtils";
import InsightComparisonBarChartUtils from "../../classes/comparator/InsightDiffBarChart/InsightComparisonBarChartUtils";
import InsightChangeBarChartUtils from "../../classes/comparator/InsightDiffBarChart/InsightChangeBarChartUtils";
import { Element } from 'react-scroll';
import {
  DiffDependencyGraphFactory
} from "../../classes/comparator/dependencyDiffGraph/DependencyDiffGraphFactory";
import {
  useGraphDifference,
  DiffDisplayUtils,
} from "../../classes/comparator/DiffDisplayUtils";
import {
  DependencyGraphUtils,
} from "../../classes/DependencyGraphUtils";
import { TGraphData } from "../../entities/TGraphData";
import { TTotalServiceInterfaceCohesion } from "../../entities/TTotalServiceInterfaceCohesion";
import { TServiceCoupling } from "../../entities/TServiceCoupling";
import { TServiceInstability } from "../../entities/TServiceInstability";
import { TInsightDiffCohesion } from "../../entities/comparator/TInsightDiffCohesion";
import { TInsightDiffCoupling } from "../../entities/comparator/TInsightDiffCoupling";
import { TInsightDiffInstability } from "../../entities/comparator/TInsightDiffInstability";
import TEndpointDataType from "../../entities/TEndpointDataType";
import Loading from "../Loading";
import ComparatorService from "../../services/ComparatorService";
import DiffMenu from "./DiffMenu";
import DiffDetailEndpoint from "./DiffDetailEndpoint";
import { InsightComparator } from "../../classes/InsightComparator";

const ForceGraph2D = lazy(() => import("react-force-graph-2d"));

type DiffDisplayProps = {
  olderVersionTag: string;
  newerVersionTag: string;
  currentVersionStr: string;
};
type VersionContext = {
  setEndpointGraphData: (data: any) => void;
  setGraphData: (data: any) => void;
  rawRef: React.MutableRefObject<string | undefined>;
  graphRef: React.MutableRefObject<any>;
  setCohesionData: (data: TTotalServiceInterfaceCohesion[]) => void;
  setCouplingData: (data: TServiceCoupling[]) => void;
  setInstabilityData: (data: TServiceInstability[]) => void;
  setEndpointDataTypesMap: (data: Record<string, TEndpointDataType>) => void;
};
const useStyles = makeStyles(() => ({
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
    position: 'relative',
    border: '0.08em solid #ccc',
    boxShadow: '0.4em 0em 0.5em rgba(0, 0, 0, 0.1)',
    float: 'left',
  },
  graphTitle: {
    fontWeight: 'normal',
    margin: 0,
    fontSize: '1rem',
  },
  graphHeader: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: 'rgba(255,255,255,0.9)',
    borderRadius: '0.5em',
    padding: '0.3em 0.5em',
    zIndex: 10,
    boxShadow: '0 0.2em 0.3em rgba(0, 0, 0, 0.1)',
  },
  switch: {
    paddingLeft: "0.8em",
  },
}));
export default function DiffDisplay(props: DiffDisplayProps) {
  if (!props.newerVersionTag || !props.olderVersionTag) return <></>;
  const classes = useStyles();
  const currentVersionStr = props.currentVersionStr;
  const olderVersionTag = props.olderVersionTag || currentVersionStr;
  const newerVersionTag = props.newerVersionTag || currentVersionStr;

  /***  graph ***/
  // the older version graph data
  const olderGraphDataRef = useRef<any>();
  const olderRawGraphDataRef = useRef<string>();
  const [olderGraphData, setOlderGraphData] = useState<any>();
  const [olderEndpointGraphData, setOlderEndpointGraphData] = useState<TGraphData | null>(null);
  //the newer version graph data
  const newerGraphDataRef = useRef<any>();
  const newerRawGraphDataRef = useRef<string>();
  const [newerGraphData, setNewerGraphData] = useState<any>();
  const [newerEndpointGraphData, setNewerEndpointGraphData] = useState<TGraphData | null>(null);

  // endpoint data types map
  const [olderEndpointDataTypesMap, setOlderEndpointDataTypesMap] = useState<Record<string, TEndpointDataType>>({});
  const [newerEndpointDataTypesMap, setNewerEndpointDataTypesMap] = useState<Record<string, TEndpointDataType>>({});

  // the diff graph data
  const diffGraphDataRef = useRef<any>();
  const rawDiffGraphDataRef = useRef<string>();
  // graph diff info
  const [diffGraphData, setDiffGraphData] = useState<any>();
  const [graphDifferenceInfo, setGraphDifferenceInfo] = useGraphDifference();

  // graph display control
  const [showEndpoint, setShowEndpoint] = useState(true);
  const [showGraphDiff, setShowGraphDiff] = useState(true);
  const [fadeNodes, setFadeNodes] = useState<string[]>([]);
  const [hilightNodeId, setHighlightNodeId] = useState<string>(''); // Clicking the diff menu item will highlight target node in diff graph
  const [showChangeDetailNodeId, setShowChangeDetailNodeId] = useState<string>(''); // Clicking the "Show Change Details" button in the diff menu item will display the change details below the diff graph



  /*** insight ***/
  //the older version insight data
  const [olderCohesionData, setOlderCohesionData] = useState<TTotalServiceInterfaceCohesion[]>([]);
  const [olderCouplingData, setOlderCouplingData] = useState<TServiceCoupling[]>([]);
  const [olderInstabilityData, setOlderInstabilityData] = useState<TServiceInstability[]>([]);
  //the newer version insight data
  const [newerCohesionData, setNewerCohesionData] = useState<TTotalServiceInterfaceCohesion[]>([]);
  const [newerCouplingData, setNewerCouplingData] = useState<TServiceCoupling[]>([]);
  const [newerinstabilityData, setNewerInstabilityData] = useState<TServiceInstability[]>([]);
  // insight diff data
  const [cohesionDiff, setCohesionDiff] = useState<TInsightDiffCohesion[]>([]);
  const [couplingDiff, setCouplingDiff] = useState<TInsightDiffCoupling[]>([]);
  const [instabilityDiff, setInstabilityDiff] = useState<TInsightDiffInstability[]>([]);
  const [showCohesionInsightDiffChart, setShowCohesionInsightDiffChart] = useState(true);
  const [showCouplingInsightDiffChart, setShowCouplingInsightDiffChart] = useState(true);
  const [showInstabilityInsightDiffChart, setShowInstabilityInsightDiffChart] = useState(true);



  /***window control***/
  const rwdWidth = 1300
  const [pageSize, setPageSize] = useState([0, 0]);
  const [gridSize, setGridSize] = useState(12);
  const [isInSmallScreen, setIsInSmallScreen] = useState(true);
  const [graphWidthRate, setCanvasWidthRate] = useState(0.5);
  const [graphHeightRate, setCanvasHeightRate] = useState(0.8);


  const newerVersionContext: VersionContext = {
    setEndpointGraphData: setNewerEndpointGraphData,
    setGraphData: setNewerGraphData,
    rawRef: newerRawGraphDataRef,
    graphRef: newerGraphDataRef,
    setCohesionData: setNewerCohesionData,
    setCouplingData: setNewerCouplingData,
    setInstabilityData: setNewerInstabilityData,
    setEndpointDataTypesMap: setNewerEndpointDataTypesMap,
  };

  const olderVersionContext: VersionContext = {
    setEndpointGraphData: setOlderEndpointGraphData,
    setGraphData: setOlderGraphData,
    rawRef: olderRawGraphDataRef,
    graphRef: olderGraphDataRef,
    setCohesionData: setOlderCohesionData,
    setCouplingData: setOlderCouplingData,
    setInstabilityData: setOlderInstabilityData,
    setEndpointDataTypesMap: setOlderEndpointDataTypesMap,
  };

  /***useEffect for window control***/
  useEffect(() => {
    const unsubscribe = [
      ViewportUtils.getInstance().subscribe(([vw]) => {
        setGridSize(vw > rwdWidth ? 6 : 12)
        setCanvasWidthRate(vw > rwdWidth ? 0.5 : 0.99);
        setCanvasHeightRate(vw > rwdWidth ? 0.8 : 0.4);
        setIsInSmallScreen(vw > rwdWidth ? false : true)
      }),
    ];
    return () => {
      unsubscribe.forEach((un) => un());
    };
  }, []);
  useLayoutEffect(() => {
    const unsubscribe = [
      ViewportUtils.getInstance().subscribe(([vw, vh]) =>
        setPageSize([vw, vh])
      ),
    ];
    return () => {
      unsubscribe.forEach((un) => un());
    };
  }, []);
  useEffect(() => {
    if (showChangeDetailNodeId) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [showChangeDetailNodeId]);

  /***  useEffect for diff  ***/
  useEffect(() => {
    if (hilightNodeId) {
      handleFadeNodesInDiffGraph([hilightNodeId]);
    } else {
      handleFadeNodesInDiffGraph([]);
    }
  }, [hilightNodeId]);

  useEffect(() => {
    fetchVersionData(
      olderVersionTag === currentVersionStr ? '' : olderVersionTag,
      olderVersionContext,
    );
  }, [olderVersionTag]);
  useEffect(() => {
    fetchVersionData(
      newerVersionTag === currentVersionStr ? '' : newerVersionTag,
      newerVersionContext,
    );
  }, [newerVersionTag]);

  useEffect(() => {
    if (
      newerEndpointGraphData &&
      olderEndpointGraphData &&
      olderEndpointDataTypesMap &&
      newerEndpointDataTypesMap
    ) {
      // console.log("newerEndpointGraphData=", newerEndpointGraphData);
      // console.log("olderEndpointGraphData", olderEndpointGraphData);

      // set showing graph data
      updateGraphData(newerEndpointGraphData, newerVersionContext);
      updateGraphData(olderEndpointGraphData, olderVersionContext,);

      // set graph diff info and diff graph data
      const nextGraphDifferenceInfo = DiffDisplayUtils.CompareTwoGraphData(
        JSON.parse(JSON.stringify(newerEndpointGraphData)),
        JSON.parse(JSON.stringify(olderEndpointGraphData)),
        olderEndpointDataTypesMap,
        newerEndpointDataTypesMap,
        showEndpoint
      );
      const nextDiffGraphData = JSON.stringify(nextGraphDifferenceInfo.diffGraphData);
      if (!rawDiffGraphDataRef.current) {
        const timer = setInterval(() => {
          if (!diffGraphDataRef.current) return;
          clearInterval(timer);
          setTimeout(() => {
            diffGraphDataRef.current.zoom(4, 0);
            diffGraphDataRef.current.centerAt(0, 0);
          }, 10);
        });
      }
      rawDiffGraphDataRef.current = nextDiffGraphData;

      // console.log("nextGraphDifferenceInfo",nextGraphDifferenceInfo);

      if (nextGraphDifferenceInfo && nextGraphDifferenceInfo.diffGraphData) {
        // console.log("nextDiffGraphData",nextDiffGraphData);
        setDiffGraphData(DependencyGraphUtils.ProcessData(showEndpoint ? JSON.parse(nextDiffGraphData) : DependencyGraphUtils.toServiceDependencyGraph(JSON.parse(nextDiffGraphData))));
      }

      setGraphDifferenceInfo(nextGraphDifferenceInfo);
    }

  }, [
    newerEndpointGraphData,
    olderEndpointGraphData,
    newerEndpointDataTypesMap,
    olderEndpointDataTypesMap,
    showEndpoint,
  ]);

  //when switch showGraphDiff, zoom and center the graph.
  useEffect(() => {
    if (!showGraphDiff && newerGraphDataRef.current) {
      newerGraphDataRef.current.zoom(3, 0);
      newerGraphDataRef.current.centerAt(0, 0);
    }
    if (!showGraphDiff && olderGraphDataRef.current) {
      olderGraphDataRef.current.zoom(3, 0);
      olderGraphDataRef.current.centerAt(0, 0);
    }
    if (showGraphDiff && !showChangeDetailNodeId && diffGraphDataRef.current) {
      diffGraphDataRef.current.zoom(4, 0);
      diffGraphDataRef.current.centerAt(0, 0);
    }
  }, [showGraphDiff, showChangeDetailNodeId]);

  //insight diff
  useEffect(() => {
    const newDataDiff = InsightComparator.getInstance().mergeCohesionDiffData([
      {
        versionTag: olderVersionTag,
        cohesionData: olderCohesionData
      },
      {
        versionTag: newerVersionTag,
        cohesionData: newerCohesionData
      }
    ]);
    setCohesionDiff(newDataDiff);
  }, [olderCohesionData, newerCohesionData]);

  useEffect(() => {
    const newDataDiff = InsightComparator.getInstance().mergeCouplingDiffData([
      {
        versionTag: olderVersionTag,
        couplingData: olderCouplingData,
      },
      {
        versionTag: newerVersionTag,
        couplingData: newerCouplingData,
      }
    ]);
    setCouplingDiff(newDataDiff);
  }, [olderCouplingData, newerCouplingData]);

  useEffect(() => {
    const newDataDiff = InsightComparator.getInstance().mergeInstabilityDiffData([
      {
        versionTag: olderVersionTag,
        instabilityData: olderInstabilityData,
      },
      {
        versionTag: newerVersionTag,
        instabilityData: newerinstabilityData,
      },
    ]);
    setInstabilityDiff(newDataDiff);
  }, [olderInstabilityData, newerinstabilityData]);

  // other function
  const fetchVersionData = async (
    tag: string, // if tag is empty string, it means current version
    versionContext: VersionContext
  ) => {
    const data = await ComparatorService.getInstance().getTaggedDiffData(tag);

    // get raw graph data
    const endpointGraph = JSON.parse(JSON.stringify(data.graphData));

    // get raw insight data
    const cohesionData = data.cohesionData;
    const couplingData = data.couplingData;
    const instabilityData = data.instabilityData;

    // get raw endpointDataTypesMap data
    const endpointDataTypesMap = data.endpointDataTypesMap;

    // set graph data
    if (endpointGraph) {
      versionContext.setEndpointGraphData(endpointGraph);
    }

    // set insight data 
    versionContext.setCohesionData(cohesionData);
    versionContext.setCouplingData(couplingData);
    versionContext.setInstabilityData(instabilityData);

    // set endpointDataTypesMap data
    versionContext.setEndpointDataTypesMap(endpointDataTypesMap);
  };

  const handleFadeNodesInDiffGraph = (nonFadedNodeIds: string[]) => {
    if (nonFadedNodeIds.length > 0) {
      const allNodeIds = graphDifferenceInfo.diffGraphData.nodes.map(node => node.id);
      const fadeNodes = allNodeIds.filter(id => !nonFadedNodeIds.includes(id));
      setFadeNodes(fadeNodes);
    } else {
      setFadeNodes([]);
    }
  };

  const updateGraphData = (
    endpointGraphData: TGraphData,
    versionContext: VersionContext
  ) => {
    const rawGraphStr = JSON.stringify(endpointGraphData);
    // console.log("showEndpoint =", showEndpoint);
    // console.log("versionContext.rawRef.current",JSON.stringify(versionContext.rawRef.current, null, 2));
    // console.log("rawGraphStr",JSON.stringify(rawGraphStr, null, 2));
    // console.log("endpointGraphData", JSON.stringify(endpointGraphData, null, 2));
    // if (versionContext.rawRef.current === rawGraphStr) return;
    if (!versionContext.rawRef.current) {
      const timer = setInterval(() => {
        if (!versionContext.graphRef.current) return;
        clearInterval(timer);
        setTimeout(() => {
          versionContext.graphRef.current!.zoom(3, 0);
          versionContext.graphRef.current!.centerAt(0, 0);
        }, 10);
      });
    }
    versionContext.rawRef.current = rawGraphStr;

    const rawshowingGraph = JSON.parse(rawGraphStr);
    const showingGraph = showEndpoint
      ? rawshowingGraph
      : DependencyGraphUtils.toServiceDependencyGraph(rawshowingGraph);
    versionContext.setGraphData(DependencyGraphUtils.ProcessData(showingGraph));
  };

  const handleCloseDetail = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };


  return (
    <>
      {/* Graph diff*/}
      <Grid item xs={12}>
        <Element name="Graph Difference Title">
          <Typography variant="h6">
            Differences in Dependency Graph:&ensp;
            <span style={{ color: '#FFA500' }}>{olderVersionTag}</span>
            &ensp;vs&ensp;
            <span style={{ color: '#00a2ff' }}>{newerVersionTag}</span>
          </Typography>
        </Element>
      </Grid>
      <Grid item xs={12} style={{ display: "flex", justifyContent: "flex-start", gap: "0.5em" }}>
        <Card className={classes.switch}>
          <FormGroup>
            <FormControlLabel
              control={
                <Switch
                  checked={showGraphDiff}
                  onChange={(e) => setShowGraphDiff(e.target.checked)}
                />
              }
              label="Show difference"
            />
          </FormGroup>
        </Card>
        <Card className={classes.switch}>
          <FormGroup>
            <FormControlLabel
              control={
                <Switch
                  checked={showEndpoint}
                  onChange={(e) => setShowEndpoint(e.target.checked)}
                />
              }
              label="Show endpoints"
            />
          </FormGroup>
        </Card>
      </Grid>
      {showGraphDiff && !showChangeDetailNodeId && (
        <Grid item xs={isInSmallScreen ? 12 : 4}>
          <Box
            sx={{
              height: isInSmallScreen ? pageSize[1] * (graphHeightRate - 0.05) - 45 : pageSize[1] * (graphHeightRate) - 45,
              overflowY: 'auto',
              border: '1px solid #ccc',
              padding: '0.2em 0.1em 0.2em 0.1em',
              backgroundColor: '#fafafa',
            }}
          >
            <DiffMenu
              addedNodeIds={graphDifferenceInfo.addedNodeIds}
              deletedNodeIds={graphDifferenceInfo.deletedNodeIds}
              changedEndpointNodesId={graphDifferenceInfo.changedEndpointNodesId}
              showEndpoint={showEndpoint}
              selectedNodeId={hilightNodeId}
              setSelectedNodeId={setHighlightNodeId}
              setShowChangeDetailNodeId={setShowChangeDetailNodeId}
            />
          </Box>
        </Grid>
      )}

      {showGraphDiff && !showChangeDetailNodeId && (
        <Grid item xs={isInSmallScreen ? 12 : 8}>
          <div className={classes.graphContainer}>
            <Box
              sx={{
                position: 'absolute',
                top: 8,
                left: 8,
                zIndex: 10,
                backgroundColor: 'rgba(255,255,255,0.9)',
                borderRadius: '0.5em',
                padding: '0.5em',
                display: 'flex',
                alignItems: 'center',
                gap: 2,
              }}
            >
              <Tooltip
                title="Endpoints or services existing in the second version but not in the first will be marked as added."
                componentsProps={{
                  tooltip: {
                    sx: { fontSize: '1em' }
                  }
                }}
              >
                <Box
                  display="flex"
                  alignItems="center"
                  gap={0.5}
                  onMouseEnter={() => {
                    handleFadeNodesInDiffGraph(graphDifferenceInfo.addedNodeIds);
                  }}
                  onMouseLeave={() => handleFadeNodesInDiffGraph(hilightNodeId ? [hilightNodeId] : [])}
                >
                  <Box sx={{ width: 20, height: 20, bgcolor: "rgba(0, 255, 0, 0.7)", borderRadius: '50%' }} />
                  <Typography variant="body2" sx={{ cursor: "help" }}>Add</Typography>
                </Box>
              </Tooltip>
              <Tooltip
                title="Endpoints or services existing in the first version but not in the second will be marked as deleted."
                componentsProps={{
                  tooltip: {
                    sx: { fontSize: '1em' }
                  }
                }}
              >
                <Box
                  display="flex"
                  alignItems="center"
                  gap={0.5}
                  onMouseEnter={() => {
                    handleFadeNodesInDiffGraph(graphDifferenceInfo.deletedNodeIds);
                  }}
                  onMouseLeave={() => handleFadeNodesInDiffGraph(hilightNodeId ? [hilightNodeId] : [])}
                >
                  <Box sx={{ width: 20, height: 20, bgcolor: "rgba(255, 0, 0, 0.7)", borderRadius: '50%' }} />
                  <Typography variant="body2" sx={{ cursor: "help" }}>Delete</Typography>
                </Box>
              </Tooltip>
              {showEndpoint && (
                <Tooltip
                  title="Endpoints with differing data types between the two versions will be marked as changed."
                  componentsProps={{
                    tooltip: {
                      sx: { fontSize: '1em' }
                    }
                  }}
                >
                  <Box
                    display="flex"
                    alignItems="center"
                    gap={0.5}
                    onMouseEnter={() => {
                      handleFadeNodesInDiffGraph(showEndpoint ? graphDifferenceInfo.changedEndpointNodesId : []);
                    }}
                    onMouseLeave={() => handleFadeNodesInDiffGraph(hilightNodeId ? [hilightNodeId] : [])}
                  >
                    <Box sx={{ width: 20, height: 20, bgcolor: "rgba(255, 165, 0, 0.7)", borderRadius: '50%' }} />
                    <Typography variant="body2" sx={{ cursor: "help" }}>Change</Typography>
                  </Box>
                </Tooltip>
              )}
            </Box>
            <Suspense fallback={<Loading />}>
              <ForceGraph2D
                ref={diffGraphDataRef}
                width={isInSmallScreen ? pageSize[0] * 0.98 - 20 : pageSize[0] * 8 / 12 - 40}
                height={isInSmallScreen ? pageSize[1] * (graphHeightRate + 0.05) - 40 : pageSize[1] * (graphHeightRate) - 40}
                graphData={diffGraphData}
                {...DiffDependencyGraphFactory.Create(
                  graphDifferenceInfo,
                  true,
                  fadeNodes
                )}
              />
            </Suspense>
          </div>
        </Grid>
      )}
      {/*TODO*/}
      {showGraphDiff && showChangeDetailNodeId && (
        <Grid item xs={12}>
          <Box
            sx={{
              height: isInSmallScreen ? 2 * (pageSize[1] * (graphHeightRate - 0.05)) : pageSize[1] * (graphHeightRate) - 45,
              overflowY: 'auto',
              border: '1px solid #ccc',
              backgroundColor: '#fafafa',
            }}
            p={1}
          >
            <DiffDetailEndpoint
              nodeId={showChangeDetailNodeId}
              graphDifferenceInfo={graphDifferenceInfo}
              oldEndpointDatatypeMap={olderEndpointDataTypesMap}
              newEndpointDatatypeMap={newerEndpointDataTypesMap}
              setShowChangeDetailNodeId={setShowChangeDetailNodeId}
              onClose={handleCloseDetail}
            />
          </Box>
        </Grid>
      )}

      {/* Graph details*/}
      {!showGraphDiff && (
        <>
          <Grid item xs={gridSize}>
            <div className={classes.graphContainer}>
              <div className={classes.graphHeader}>
                <h4 className={classes.graphTitle}>
                  {olderVersionTag}
                </h4>
              </div>
              <Suspense fallback={<Loading />}>
                <ForceGraph2D
                  ref={olderGraphDataRef}
                  width={pageSize[0] * graphWidthRate - 35}
                  height={pageSize[1] * graphHeightRate - 40}
                  graphData={olderGraphData}
                  {...DiffDependencyGraphFactory.Create(graphDifferenceInfo, false)}
                />
              </Suspense>
            </div>
          </Grid>

          <Grid item xs={gridSize}>
            <div className={classes.graphContainer}>
              <div className={classes.graphHeader}>
                <h4 className={classes.graphTitle}>
                  {newerVersionTag}
                </h4>
              </div>
              <Suspense fallback={<Loading />}>
                <ForceGraph2D
                  ref={newerGraphDataRef}
                  width={pageSize[0] * graphWidthRate - 35}
                  height={pageSize[1] * graphHeightRate - 40}
                  graphData={newerGraphData}
                  {...DiffDependencyGraphFactory.Create(graphDifferenceInfo, false)}
                />
              </Suspense>
            </div>
          </Grid>
        </>
      )}


      {/* Cohesion diff*/}
      <Grid item xs={12}>
        <Element name="Cohesion Difference Title">
          <Typography variant="h6">Differences in Service Cohesion</Typography>
        </Element>
      </Grid>
      <Grid item xs={12} style={{ display: "flex", justifyContent: "flex-start", gap: "0.5em" }}>
        <Card className={classes.switch}>
          <FormGroup>
            <FormControlLabel
              control={
                <Switch
                  checked={showCohesionInsightDiffChart}
                  onChange={(e) => setShowCohesionInsightDiffChart(e.target.checked)}
                />
              }
              label="Show difference"
            />
          </FormGroup>
        </Card>
      </Grid>
      <Grid item xs={gridSize} style={{ display: showCohesionInsightDiffChart ? 'block' : 'none' }}>
        <ReactApexChart
          {...InsightComparisonBarChartUtils.CreateComparisonBarChart(
            "Service Cohesion (TSIC) Comparison",
            cohesionDiff,
            InsightComparisonBarChartUtils.SeriesFromServiceCohesionComparison,
            [
              olderVersionTag,
              newerVersionTag,
            ],
            false,
            InsightComparisonBarChartUtils.ServiceCohesionComparisonOpts(
              cohesionDiff,
              [
                olderVersionTag,
                newerVersionTag,
              ]
            ),
            600,
            "TSIC"
          )}
        ></ReactApexChart>
      </Grid>
      <Grid item xs={gridSize} style={{ display: showCohesionInsightDiffChart ? 'block' : 'none' }}>
        <ReactApexChart
          {...InsightChangeBarChartUtils.CreateChangesBarChart(
            "Service Cohesion (TSIC) Change",
            cohesionDiff,
            InsightChangeBarChartUtils.SeriesFromCohesionChange,
            olderVersionTag,
            newerVersionTag,
            false,
            InsightChangeBarChartUtils.CohesionChangeBarChartOpts(
              cohesionDiff,
              olderVersionTag,
              newerVersionTag
            ),
            600,
            "TSIC",
            "(Change from 1st version to 2nd version)"
          )}
        ></ReactApexChart>
      </Grid>

      {/* Cohesion details*/}
      <Grid item xs={gridSize} style={{ display: showCohesionInsightDiffChart ? 'none' : 'block' }}>
        <ReactApexChart
          {...BarChartUtils.CreateBarChart(
            `Service Cohesion (${olderVersionTag})`,
            olderCohesionData,
            BarChartUtils.SeriesFromServiceCohesion,
            true,
            BarChartUtils.ServiceCohesionOpts(olderCohesionData)
          )}
        ></ReactApexChart>
      </Grid>
      <Grid item xs={gridSize} style={{ display: showCohesionInsightDiffChart ? 'none' : 'block' }} >
        <ReactApexChart
          {...BarChartUtils.CreateBarChart(
            `Service Cohesion (${newerVersionTag})`,
            newerCohesionData,
            BarChartUtils.SeriesFromServiceCohesion,
            true,
            BarChartUtils.ServiceCohesionOpts(newerCohesionData)
          )}
        ></ReactApexChart>
      </Grid>

      {/* Coupling diff*/}
      <Grid item xs={12}>
        <Element name="Coupling Difference Title">
          <Typography variant="h6">Differences in Service Coupling</Typography>
        </Element>
      </Grid>
      <Grid item xs={12} style={{ display: "flex", justifyContent: "flex-start", gap: "0.5em" }}>
        <Card className={classes.switch}>
          <FormGroup>
            <FormControlLabel
              control={
                <Switch
                  checked={showCouplingInsightDiffChart}
                  onChange={(e) => setShowCouplingInsightDiffChart(e.target.checked)}
                />
              }
              label="Show difference"
            />
          </FormGroup>
        </Card>
      </Grid>
      <Grid item xs={gridSize} style={{ display: showCouplingInsightDiffChart ? 'block' : 'none' }}>
        <ReactApexChart
          {...InsightComparisonBarChartUtils.CreateComparisonBarChart(
            "Service Coupling (ACS) Comparison",
            couplingDiff,
            InsightComparisonBarChartUtils.SeriesFromServiceCouplingComparison,
            [
              olderVersionTag,
              newerVersionTag,
            ],
            false,
            InsightComparisonBarChartUtils.ServiceCouplingComparisonOpts(
              couplingDiff,
              [
                olderVersionTag,
                newerVersionTag,
              ]
            ),
            600,
            "ACS"
          )}
        />
      </Grid>
      <Grid item xs={gridSize} style={{ display: showCouplingInsightDiffChart ? 'block' : 'none' }}>
        <ReactApexChart
          {...InsightChangeBarChartUtils.CreateChangesBarChart(
            "Service Coupling (ACS) Change",
            couplingDiff,
            InsightChangeBarChartUtils.SeriesFromCouplingChange,
            olderVersionTag,
            newerVersionTag,
            false,
            InsightChangeBarChartUtils.CouplingChangeBarChartOpts(
              couplingDiff,
              olderVersionTag,
              newerVersionTag
            ),
            600,
            "ACS",
            "(Change from 1st version to 2nd version)"
          )}
        />
      </Grid>

      {/* Coupling details*/}
      <Grid item xs={gridSize} style={{ display: showCouplingInsightDiffChart ? 'none' : 'block' }}>
        <ReactApexChart
          {...BarChartUtils.CreateBarChart(
            `Service Coupling (${olderVersionTag})`,
            olderCouplingData,
            BarChartUtils.SeriesFromServiceCoupling,
            true,
            BarChartUtils.ServiceCouplingOpts(olderCouplingData)
          )}
        ></ReactApexChart>
      </Grid>
      <Grid item xs={gridSize} style={{ display: showCouplingInsightDiffChart ? 'none' : 'block' }}>
        <ReactApexChart
          {...BarChartUtils.CreateBarChart(
            `Service Coupling (${newerVersionTag})`,
            newerCouplingData,
            BarChartUtils.SeriesFromServiceCoupling,
            true,
            BarChartUtils.ServiceCouplingOpts(newerCouplingData)
          )}
        ></ReactApexChart>
      </Grid>

      {/* Instabilitydiff*/}
      <Grid item xs={12}>
        <Element name="Instability Difference Title">
          <Typography variant="h6">Differences in Service Instability</Typography>
        </Element>
      </Grid>
      <Grid item xs={12} style={{ display: "flex", justifyContent: "flex-start", gap: "0.5em" }}>
        <Card className={classes.switch}>
          <FormGroup>
            <FormControlLabel
              control={
                <Switch
                  checked={showInstabilityInsightDiffChart}
                  onChange={(e) => setShowInstabilityInsightDiffChart(e.target.checked)}
                />
              }
              label="Show difference"
            />
          </FormGroup>
        </Card>
      </Grid>
      <Grid item xs={gridSize} style={{ display: showInstabilityInsightDiffChart ? 'block' : 'none' }}>
        <ReactApexChart
          {...InsightComparisonBarChartUtils.CreateComparisonBarChart(
            "Service Instability (SDP) Comparison",
            instabilityDiff,
            InsightComparisonBarChartUtils.SeriesFromServiceInstabilityComparison,
            [olderVersionTag, newerVersionTag],
            false,
            InsightComparisonBarChartUtils.ServiceInstabilityComparisonOpts(
              instabilityDiff,
              [olderVersionTag, newerVersionTag],
            ),
            600,
            "SDP"
          )}
        />
      </Grid>
      <Grid item xs={gridSize} style={{ display: showInstabilityInsightDiffChart ? 'block' : 'none' }}>
        <ReactApexChart
          {...InsightChangeBarChartUtils.CreateChangesBarChart(
            "Service Instability (SDP) Change",
            instabilityDiff,
            InsightChangeBarChartUtils.SeriesFromInstabilityChange,
            olderVersionTag,
            newerVersionTag,
            false,
            InsightChangeBarChartUtils.InstabilityChangeBarChartOpts(
              instabilityDiff,
              olderVersionTag,
              newerVersionTag
            ),
            600,
            "SDP",
            "(Change from 1st version to 2nd version)"
          )}
        />
      </Grid>

      {/* Instability details*/}
      <Grid item xs={gridSize} style={{ display: showInstabilityInsightDiffChart ? 'none' : 'block' }}>
        <ReactApexChart
          {...BarChartUtils.CreateBarChart(
            `Service Instability (${olderVersionTag})`,
            olderInstabilityData,
            BarChartUtils.SeriesFromServiceInstability,
            false,
            BarChartUtils.ServiceInstabilityOpts(olderInstabilityData)
          )}
        ></ReactApexChart>
      </Grid>
      <Grid item xs={gridSize} style={{ display: showInstabilityInsightDiffChart ? 'none' : 'block' }}>
        <ReactApexChart
          {...BarChartUtils.CreateBarChart(
            `Service Instability (${newerVersionTag})`,
            newerinstabilityData,
            BarChartUtils.SeriesFromServiceInstability,
            false,
            BarChartUtils.ServiceInstabilityOpts(newerinstabilityData)
          )}
        ></ReactApexChart>
      </Grid>

    </>
  );
}
