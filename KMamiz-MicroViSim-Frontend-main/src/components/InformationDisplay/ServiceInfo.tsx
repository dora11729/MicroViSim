import {
  Card,
  IconButton,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
} from "@mui/material";
import { Article, FiberManualRecord, Warning } from "@mui/icons-material";
import { TAggregatedServiceInfo } from "../../entities/TAggregatedData";
import { TServiceDisplayInfo } from "../../entities/TServiceDisplayInfo";
import { useEffect, useState } from "react";
import DataService from "../../services/DataService";


function roundNumber(num: number) {
  return Math.round(num * 10000) / 10000;
}
function sumField(field: string, obj: any[]) {
  return obj.reduce((prev, s: any) => prev + s[field], 0);
}

export default function ServiceInfo(props: {
  service: string;
  namespace: string;
}) {
  const [aggregatedServiceInfo, setAggregatedServiceInfo] = useState<TAggregatedServiceInfo[]>([]);
  const [noAggregatedServiceInfo, setNoAggregatedServiceInfo] = useState<TServiceDisplayInfo[]>([]);
  useEffect(() => {
    const unSub = DataService.getInstance().subscribeToAggregatedData(
      (data) => {
        setAggregatedServiceInfo(
          data
            ? data.services.sort((a, b) => a.version.localeCompare(b.version))
            : []
        );
      },
      undefined,
      `${props.service}\t${props.namespace}`
    );
    return () => {
      unSub();
    };
  }, [props.service, props.namespace]);

  useEffect(() => {
    const unSub = DataService.getInstance().subscribeToServiceDisplayInfo(
      (data) => {
        setNoAggregatedServiceInfo(
          data
            ? data.sort((a, b) => a.version.localeCompare(b.version))
            : []
        );
      },
      `${props.service}\t${props.namespace}`
    );
    return () => {
      unSub();
    };
  }, [props.service, props.namespace]);

  const endpointsCount =
    aggregatedServiceInfo.length > 0
      ? [
        ...new Set<string>(
          aggregatedServiceInfo
            .map((s) => s.endpoints.map((e) => ({ ...e, version: s.version })))
            .flat()
            .map((e) => `${e.version}\t${e.method}\t${e.labelName}`)
        ),
      ].length
      : noAggregatedServiceInfo.reduce((sum, s) => sum + s.endpointCount, 0);// When endpoint aggregation data is unavailable, attempt to retrieve the required information from static data.

  return (
    <div>
      <List>
        <ListItem disablePadding>
          <ListItemIcon>
            <FiberManualRecord color="secondary" />
          </ListItemIcon>
          <ListItemText primary={`Endpoints: ${endpointsCount}`} />
        </ListItem>
        <ListItem disablePadding>
          <ListItemIcon>
            <Warning color="warning" />
          </ListItemIcon>
          <ListItemText
            primary={`Combined Risk: ${roundNumber(
              aggregatedServiceInfo.length > 0 ? sumField("avgRisk", aggregatedServiceInfo) / aggregatedServiceInfo.length : 0
            )}`}
          />
        </ListItem>
      </List>
      <TableContainer component={Paper} variant="outlined">
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Version</TableCell>
              <TableCell>Risk</TableCell>
              <TableCell>Docs</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(aggregatedServiceInfo.length > 0 ? aggregatedServiceInfo : noAggregatedServiceInfo).map((s) => (
              <TableRow key={s.version}>
                <TableCell>{s.version}</TableCell>
                <TableCell>{("avgRisk" in s) ? roundNumber(s.avgRisk) : 0}</TableCell>
                <TableCell>
                  <Tooltip title="Open SwaggerUI">
                    <IconButton
                      color="primary"
                      onClick={() => {
                        window.open(
                          `/swagger/${encodeURIComponent(s.uniqueServiceName)}`,
                          "_blank"
                        );
                      }}
                    >
                      <Article />
                    </IconButton>
                  </Tooltip>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </div>
  );
}
