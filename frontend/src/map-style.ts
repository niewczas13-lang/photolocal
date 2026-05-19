import type {
  ProjectMapCableRoutingType,
  ProjectMapCableStatus,
  ProjectMapInfraNode,
  ProjectMapNodeStatus,
} from './types';

export type MarkerTone = 'addressPending' | 'notApplicable' | 'done' | 'nodePhoto' | 'osd' | 'opp' | 'zs';

export interface MarkerToneStyle {
  color: string;
  border: string;
}

export interface CableLineStyle {
  color: string;
  dashArray?: string;
  dashOffset?: string;
  opacity: number;
  weight: number;
}

const CABLE_DASH = '8 16';
const CABLE_OVERLAY_DASH_OFFSET = '8';
const AERIAL_BLUE = '#2563eb';
const EXISTING_DUCT_PURPLE = '#7c3aed';
const UNDERGROUND_BROWN = '#92400e';
const PROGRESS_ORANGE = '#f97316';
const READY_GREEN = '#22c55e';

function getCableBaseColor(routingType: ProjectMapCableRoutingType): string {
  if (routingType === 'aerial') return AERIAL_BLUE;
  if (routingType === 'existing_duct') return EXISTING_DUCT_PURPLE;
  return UNDERGROUND_BROWN;
}

function getCableOverlayColor(
  status: ProjectMapCableStatus,
  routingType: ProjectMapCableRoutingType,
): string | null {
  if (routingType === 'aerial') {
    return status === 'SUSPENDED' || status === 'PULLED' || status === 'WELDED' ? READY_GREEN : null;
  }

  if (status === 'DUCT_READY') return PROGRESS_ORANGE;
  if (status === 'PULLED' || status === 'WELDED') return READY_GREEN;
  return null;
}

export function getCableLineStyles(
  status: ProjectMapCableStatus,
  routingType: ProjectMapCableRoutingType,
): CableLineStyle[] {
  const weight = routingType === 'aerial' ? 4 : 5;
  const baseStyle: CableLineStyle = {
    color: getCableBaseColor(routingType),
    dashArray: CABLE_DASH,
    opacity: 0.9,
    weight,
  };
  const overlayColor = getCableOverlayColor(status, routingType);

  if (!overlayColor) return [baseStyle];

  return [
    baseStyle,
    {
      ...baseStyle,
      color: overlayColor,
      dashOffset: CABLE_OVERLAY_DASH_OFFSET,
      opacity: 0.94,
    },
  ];
}

export function getCableLineStyle(
  status: ProjectMapCableStatus,
  routingType: ProjectMapCableRoutingType,
): CableLineStyle {
  return getCableLineStyles(status, routingType)[0];
}

export function isCableReady(status: ProjectMapCableStatus): boolean {
  return status === 'PULLED' || status === 'WELDED' || status === 'SUSPENDED';
}

export function isNodeReady(status: ProjectMapNodeStatus, _hasPhoto: boolean): boolean {
  return status === 'WELDED';
}

export function getMarkerTone(
  node: Pick<ProjectMapInfraNode, 'nodeType' | 'status' | 'hasPhoto'>,
): MarkerTone {
  if (isNodeReady(node.status, node.hasPhoto)) return 'done';
  if (node.hasPhoto) return 'nodePhoto';
  if (node.nodeType === 'OSD') return 'osd';
  if (node.nodeType === 'OPP') return 'opp';
  return 'zs';
}

export function getMarkerToneStyle(tone: MarkerTone): MarkerToneStyle {
  if (tone === 'done') return { color: '#16a34a', border: '#166534' };
  if (tone === 'nodePhoto') return { color: '#f97316', border: '#c2410c' };
  if (tone === 'notApplicable') return { color: '#94a3b8', border: '#475569' };
  if (tone === 'osd') return { color: '#2563eb', border: '#1d4ed8' };
  if (tone === 'opp') return { color: '#9333ea', border: '#7e22ce' };
  if (tone === 'zs') return { color: '#0891b2', border: '#0e7490' };
  return { color: '#dc2626', border: '#991b1b' };
}
