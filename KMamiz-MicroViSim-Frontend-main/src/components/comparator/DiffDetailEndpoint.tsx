import { useState, useEffect, Suspense } from "react";
import {
  GraphDifferenceInfo,
  EndpointDataTypeDifferenceInfo,
} from "../../classes/comparator/DiffDisplayUtils";
import TEndpointDataType from "../../entities/TEndpointDataType";
import {
  Box,
  Grid,
  Button,
  Typography,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
} from "@mui/material";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faXmark } from "@fortawesome/free-solid-svg-icons";
import EndpointInfoTable from "./EndpointInfoTable";
import InterfaceDiffDisplay from "../InterfaceDiffDisplay";
import Loading from "../Loading";

type Props = {
  nodeId: string | null;
  graphDifferenceInfo: GraphDifferenceInfo;
  oldEndpointDatatypeMap: Record<string, TEndpointDataType>;
  newEndpointDatatypeMap: Record<string, TEndpointDataType>;
  setShowChangeDetailNodeId: (nodeId: string) => void;
  onClose: () => void;
};

export default function DiffDetailEndpoint({
  nodeId,
  graphDifferenceInfo,
  oldEndpointDatatypeMap,
  newEndpointDatatypeMap,
  setShowChangeDetailNodeId,
  onClose,
}: Props) {
  if (!nodeId) return null;

  const diffInfoMap = graphDifferenceInfo.diffInfoMap;
  const diffInfo: EndpointDataTypeDifferenceInfo | undefined = diffInfoMap.get(nodeId);

  const hasRequestChange = diffInfo ? !diffInfo.isRequestSchemaEqual : false;
  const hasResponseChange = diffInfo ? diffInfo.responseSchemaDiffStatusCodes.length > 0 : false;

  const [viewMode, setViewMode] = useState<"req" | "res" | "">(() => {
    if (hasRequestChange) return "req";
    if (hasResponseChange) return "res";
    return "";
  });

  const [selectedStatus, setSelectedStatus] = useState<string | null>(null);

  useEffect(() => {
    if (hasRequestChange) setViewMode("req");
    else if (hasResponseChange) setViewMode("res");
    else setViewMode("");
    setSelectedStatus(null);
  }, [nodeId, hasRequestChange, hasResponseChange]);

  useEffect(() => {
    if (viewMode === "res" && diffInfo?.responseSchemaDiffStatusCodes.length) {
      setSelectedStatus(diffInfo.responseSchemaDiffStatusCodes[0]);
    }
  }, [viewMode, diffInfo?.responseSchemaDiffStatusCodes]);

  if (!diffInfo) {
    return <Typography>No difference information for endpoint: {nodeId}</Typography>;
  }

  const oldEndpoint = oldEndpointDatatypeMap[nodeId];
  const newEndpoint = newEndpointDatatypeMap[nodeId];

  const findSchemaByStatus = (endpoint: TEndpointDataType | undefined, status: string) => {
    return endpoint?.schemas.find((s) => s.status === status) || null;
  };

  const oldSchema = selectedStatus ? findSchemaByStatus(oldEndpoint, selectedStatus) : null;
  const newSchema = selectedStatus ? findSchemaByStatus(newEndpoint, selectedStatus) : null;

  const firstSchema =
    viewMode === "req"
      ? oldEndpoint?.schemas.find((s) => s.status.startsWith("2"))?.requestSchema || "interface Root {\n}"
      : viewMode === "res" && selectedStatus
        ? oldSchema?.responseSchema || "interface Root {\n}"
        : "interface Root {\n}";

  const secondSchema =
    viewMode === "req"
      ? newEndpoint?.schemas.find((s) => s.status.startsWith("2"))?.requestSchema || "interface Root {\n}"
      : viewMode === "res" && selectedStatus
        ? newSchema?.responseSchema || "interface Root {\n}"
        : "interface Root {\n}";

  const getLabelName = () => {
    if (viewMode === "req") return "Request Schema";
    if (viewMode === "res" && selectedStatus) return `Response Schema (${selectedStatus})`;
    return "";
  };

  const [service, namespace, version, method, path] = nodeId.split("\t");

  return (
    <Grid container spacing={2}>
      {/* Close Button */}
      <Grid
        container
        alignItems="center"
        justifyContent="center"
        position="relative"
        sx={{ mb: 2, ml: 2, mt: 2 }}
      >
        <Button
          variant="contained"
          size="small"
          color="error"
          onClick={() => {
            setShowChangeDetailNodeId("");
            onClose();
          }}
          startIcon={<FontAwesomeIcon icon={faXmark} />}
          sx={{
            position: "absolute",
            left: 0,
            zIndex: 10,
            textTransform: "none",
            borderRadius: "999px",
          }}
        >
          Close
        </Button>

        <Typography variant="h6" align="center" sx={{ width: "100%" }}>
          Endpoint Schema Change Details
        </Typography>
      </Grid>

      {/* Endpoint Summary Table */}
      <Grid item xs={12}>
        <EndpointInfoTable
          namespace={namespace}
          service={service}
          version={version}
          method={method}
          path={path}
        />
      </Grid>

      {/* Mode Selector */}
      {(hasRequestChange || hasResponseChange) && (
        <Grid item xs={12} container spacing={1}>
          <Grid item xs={6}>
            <FormControl fullWidth size="small">
              <InputLabel id="view-mode-label">View Request or Response Schema diff</InputLabel>
              <Select
                labelId="view-mode-label"
                id="view-mode-select"
                value={viewMode}
                onChange={(e) => setViewMode(e.target.value as "req" | "res")}
                label="View Request or Response Schema diff"
              >
                <MenuItem value="req" disabled={!hasRequestChange}>
                  Request{!hasRequestChange && " (no schema changes)"}
                </MenuItem>
                <MenuItem value="res" disabled={!hasResponseChange}>
                  Response{!hasResponseChange && " (no schema changes)"}
                </MenuItem>
              </Select>
            </FormControl>
          </Grid>

          {viewMode === "res" && hasResponseChange && (
            <Grid item xs={6}>
              <FormControl fullWidth size="small">
                <InputLabel id="response-status-label">HTTP Status</InputLabel>
                <Select
                  labelId="response-status-label"
                  value={selectedStatus || ""}
                  onChange={(e) => setSelectedStatus(e.target.value)}
                  displayEmpty
                  label="HTTP Status"
                  inputProps={{ "aria-label": "Select Response HTTP Status" }}
                >
                  {diffInfo.responseSchemaDiffStatusCodes.map((status) => (
                    <MenuItem key={status} value={status}>
                      {status}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>
          )}
        </Grid>
      )}

      {/* Unified Diff Display */}
      {(viewMode === "req" || (viewMode === "res" && selectedStatus)) && (
        <Grid item xs={12}>
          <Suspense fallback={<Loading />}>
            {firstSchema && secondSchema && (
              <InterfaceDiffDisplay
                name={getLabelName()}
                oldStr={firstSchema}
                newStr={secondSchema}
              />
            )}
          </Suspense>
        </Grid>
      )}
    </Grid>
  );
}
