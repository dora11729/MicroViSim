import {
  useEffect,
  Fragment
} from "react";

import {
  List,
  Button,
  ListItemIcon,
  Box,
  Divider,
  Typography,
  ListItemButton,
} from '@mui/material';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faSquarePlus,
  faSquareMinus,
} from '@fortawesome/free-regular-svg-icons';
import { faSquarePen } from '@fortawesome/free-solid-svg-icons';
import { Color } from '../../classes/ColorUtils';
import { makeStyles } from '@mui/styles';


const HexagonIcon = ({ serviceNodeId }: { serviceNodeId: string }) => {
  const color = Color.generateFromString(serviceNodeId).hex;
  const textColor = Color.fromHex(color)!.decideForeground()!.hex;
  const size = 40;
  const centerX = 50;
  const centerY = 50;
  const points = Array.from({ length: 6 }, (_, i) => {
    const angle = (Math.PI / 3) * i - Math.PI / 2;
    const x = centerX + size * Math.cos(angle);
    const y = centerY + size * Math.sin(angle);
    return `${x},${y}`;
  }).join(' ');

  return (
    <svg width="45" height="45" viewBox="0 0 100 100">
      <polygon points={points} fill={color} />
      <text
        x="50"
        y="60"
        textAnchor="middle"
        fontSize="30"
        fill={textColor}
        pointerEvents="none"
      >
        SVC
      </text>
    </svg>
  );
};

const CircleIcon = ({ serviceNodeId }: { serviceNodeId: string }) => {
  const color = Color.generateFromString(serviceNodeId).hex;
  const textColor = Color.fromHex(color)!.decideForeground()!.hex;
  return (
    <svg width="45" height="45" viewBox="0 0 100 100">
      <circle cx="50" cy="50" r="40" fill={color} />
      <text
        x="50"
        y="60"
        textAnchor="middle"
        fontSize="30"
        fill={textColor}
        pointerEvents="none"
      >
        EP
      </text>
    </svg>
  );
};

const getServiceNodeId = (nodeId: string) =>
  nodeId.split('\t').slice(0, 2).join('\t');

const formatServiceNodeId = (serviceNodeId: string) =>
  serviceNodeId.split('\t').join('.');

const formatEndpointNodeId = (nodeId: string) => {
  const parts = nodeId.split('\t');
  const version = parts[2] || '';
  const method = parts[3] || '';
  const path = parts[4] || '';
  return `(${version}) ${method} ${path}`;
};

type Props = {
  addedNodeIds: string[];
  deletedNodeIds: string[];
  changedEndpointNodesId: string[];
  showEndpoint: boolean;
  selectedNodeId: string;
  setSelectedNodeId: (nodeId: string) => void;
  setShowChangeDetailNodeId: (endpointId: string) => void;
};

const renderIcon = (type: 'add' | 'delete' | 'change') => {
  const config = {
    add: {
      icon: faSquarePlus,
      color: 'rgba(0, 255, 0, 0.7)',
    },
    delete: {
      icon: faSquareMinus,
      color: 'rgba(255, 0, 0, 0.7)',
    },
    change: {
      icon: faSquarePen,
      color: 'rgba(255, 165, 0, 0.7)',
    },
  };
  const { icon, color } = config[type];
  return <FontAwesomeIcon icon={icon} style={{ color, fontSize: 18 }} />;
};

const useStyles = makeStyles(() => ({
  sectionTitle: {
    marginBottom: '8px',
    marginTop: '16px',
  },
  sectionDivider: {
    marginBottom: '16px',
    borderTop: '3px solid #999',
  },
  listContainer: {
    backgroundColor: 'white',
    marginBottom: '16px',
    borderRadius: '8px',
    boxShadow: '0px 1px 3px rgba(0,0,0,0.2)',
  },
  iconBox: {
    width: '24px',
    textAlign: 'center',
    marginRight: '8px',
    flexShrink: 0,
  },
  listItem: {
    '&:hover': {
      backgroundColor: 'rgba(0, 0, 0, 0.04)',
    },
    '&.Mui-selected': {
      backgroundColor: 'rgba(0, 0, 0, 0.2)',
    },
    '&.Mui-selected:hover': {
      backgroundColor: 'rgba(0, 0, 0, 0.24)',
    },
  },
  listItemIcon: {
    minWidth: '36px',
    flexShrink: 0,
  },
  listItemText: {
    flexGrow: 1,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
  },
  root: {
    maxHeight: '100%',
    backgroundColor: '#fafafa',
    padding: '0.2em 0.1em',
  },
}));

export default function DiffMenu({
  addedNodeIds,
  deletedNodeIds,
  changedEndpointNodesId,
  showEndpoint,
  selectedNodeId,
  setSelectedNodeId,
  setShowChangeDetailNodeId,
}: Props) {
  const classes = useStyles();

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-node-id]')) {
        setSelectedNodeId('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [setSelectedNodeId]);

  const getServices = (nodeIds: string[]) =>
    nodeIds.filter((id) => id === getServiceNodeId(id));

  const addedServices = getServices(addedNodeIds);
  const deletedServices = getServices(deletedNodeIds);

  const isSelected = (id: string) => selectedNodeId === id;

  const handleClick = (id: string) => {
    const newSelectedId = selectedNodeId === id ? '' : id;
    setSelectedNodeId(newSelectedId);
  };

  const renderServiceList = () => {
    const allServices = [
      ...addedServices.map((id) => ({ id, type: 'add' as const })),
      ...deletedServices.map((id) => ({ id, type: 'delete' as const })),
    ];

    return (
      <>
        <Typography variant="h6" className={classes.sectionTitle}>
          Services
        </Typography>
        <Divider className={classes.sectionDivider} />
        {allServices.length === 0 ? (
          <Typography variant="body2" style={{ paddingLeft: 16, color: '#666' }}>
            No added or deleted services.
          </Typography>
        ) : (
          <List dense className={classes.listContainer}>
            {allServices.map(({ id, type }, idx) => (
              <Fragment key={`${type}-service-${id}`}>
                <ListItemButton
                  data-node-id={id}
                  selected={isSelected(id)}
                  onClick={() => handleClick(id)}
                  className={classes.listItem}
                >
                  <Box style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
                    <Box className={classes.iconBox}>{renderIcon(type)}</Box>
                    <ListItemIcon className={classes.listItemIcon}>
                      <HexagonIcon serviceNodeId={id} />
                    </ListItemIcon>

                    <Box className={classes.listItemText}>
                      <Typography component="span" style={{ fontSize: '0.9rem' }}>
                        {formatServiceNodeId(id)}
                      </Typography>
                    </Box>
                  </Box>
                </ListItemButton>
                {idx !== allServices.length - 1 && <Divider component="li" />}
              </Fragment>
            ))}
          </List>
        )}
      </>
    );
  };

  const renderEndpointList = () => {
    if (!showEndpoint) return null;

    const groupByService = (
      items: { id: string; type: 'add' | 'delete' | 'change' }[]
    ) => {
      return items.reduce<Record<string, { id: string; type: 'add' | 'delete' | 'change' }[]>>(
        (acc, cur) => {
          const svcId = getServiceNodeId(cur.id);
          if (!acc[svcId]) acc[svcId] = [];
          acc[svcId].push(cur);
          return acc;
        },
        {}
      );
    };

    const allEndpoints = [
      ...addedNodeIds
        .filter((id) => id !== getServiceNodeId(id))
        .map((id) => ({ id, type: 'add' as const })),
      ...deletedNodeIds
        .filter((id) => id !== getServiceNodeId(id))
        .map((id) => ({ id, type: 'delete' as const })),
      ...changedEndpointNodesId.map((id) => ({ id, type: 'change' as const })),
    ];

    const hasEndpoints = allEndpoints.length > 0;
    const groupedEndpoints = groupByService(allEndpoints);

    return (
      <>
        <Typography variant="h6" className={classes.sectionTitle} style={{ marginTop: 32 }}>
          Endpoints
        </Typography>
        <Divider className={classes.sectionDivider} />
        {!hasEndpoints ? (
          <Typography variant="body2" style={{ paddingLeft: 16, color: '#666' }}>
            No differences in endpoints.
          </Typography>
        ) : (
          Object.entries(groupedEndpoints).map(([serviceId, endpoints]) => (
            <Box key={`ep-group-${serviceId}`} style={{ marginBottom: 16 }}>
              <Typography variant="subtitle1" style={{ fontWeight: 'bold', marginBottom: 8 }}>
                {formatServiceNodeId(serviceId)}
              </Typography>
              <List dense className={classes.listContainer}>
                {endpoints.map(({ id, type }, idx) => (
                  <Fragment key={`${type}-endpoint-${id}`}>
                    <ListItemButton
                      data-node-id={id}
                      selected={isSelected(id)}
                      onClick={() => handleClick(id)}
                      className={classes.listItem}
                    >
                      <Box style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
                        <Box className={classes.iconBox}>{renderIcon(type)}</Box>

                        {/* TODO 取消註解即可 但是要先完成DiffDetailEndpoint*/}
                        {type === 'change' && isSelected(id) && (
                          <Button
                            variant="contained"
                            color="info"
                            size="small"
                            style={{ marginRight: 8, minWidth: 'auto', padding: '4px 8px', whiteSpace: 'nowrap' }}
                            onClick={(e) => {
                              e.stopPropagation();
                              setShowChangeDetailNodeId(id);
                            }}
                          >
                            Show Change Details
                          </Button>
                        )}

                        <ListItemIcon className={classes.listItemIcon}>
                          <CircleIcon serviceNodeId={serviceId} />
                        </ListItemIcon>

                        <Box className={classes.listItemText} style={{ flexGrow: 1, overflow: 'hidden' }}>
                          <Typography component="span" style={{ fontSize: '0.8rem' }}>
                            {formatEndpointNodeId(id)}
                          </Typography>
                        </Box>
                      </Box>
                    </ListItemButton>
                    {idx !== endpoints.length - 1 && <Divider component="li" />}
                  </Fragment>
                ))}
              </List>
            </Box>
          ))
        )}
      </>
    );
  };

  return (
    <div className={classes.root}>
      {renderServiceList()}
      {renderEndpointList()}
    </div>
  );
}