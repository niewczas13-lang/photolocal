import type {
  ProjectMapCableRoutingType,
  ProjectMapCableStatus,
  ProjectMapInfraNode,
  ProjectMapNodeStatus,
} from './types';

export type MarkerTone = 'addressPending' | 'done' | 'osd' | 'opp' | 'zs';

export interface MarkerToneStyle {
  color: string;
  border: string;
}

export interface CableLineStyle {
  color: string;
  dashArray?: string;
  opacity: number;
  weight: number;
}

export function getCableLineStyle(
  status: ProjectMapCableStatus,
  routingType: ProjectMapCableRoutingType,
): CableLineStyle {
  const isAerial = routingType === 'aerial';
  const dashArray = isAerial ? '8 6' : undefined;

  if (status === 'DUCT_READY') {
    return { color: '#ca8a04', dashArray, opacity: 0.9, weight: isAerial ? 4 : 5 };
  }

  if (status === 'PULLED' || status === 'WELDED' || status === 'SUSPENDED') {
    return { color: '#15803d', dashArray, opacity: 0.92, weight: isAerial ? 4 : 5 };
  }

  return { color: isAerial ? '#2563eb' : '#b45309', dashArray, opacity: 0.9, weight: isAerial ? 4 : 5 };
}

export function isCableReady(status: ProjectMapCableStatus): boolean {
  return status === 'PULLED' || status === 'WELDED' || status === 'SUSPENDED';
}

export function isNodeReady(status: ProjectMapNodeStatus, hasPhoto: boolean): boolean {
  return status === 'WELDED' || hasPhoto;
}

export function getMarkerTone(
  node: Pick<ProjectMapInfraNode, 'nodeType' | 'status' | 'hasPhoto'>,
): MarkerTone {
  if (isNodeReady(node.status, node.hasPhoto)) return 'done';
  if (node.nodeType === 'OSD') return 'osd';
  if (node.nodeType === 'OPP') return 'opp';
  return 'zs';
}

export function getMarkerToneStyle(tone: MarkerTone): MarkerToneStyle {
  if (tone === 'done') return { color: '#16a34a', border: '#166534' };
  if (tone === 'osd') return { color: '#2563eb', border: '#1d4ed8' };
  if (tone === 'opp') return { color: '#9333ea', border: '#7e22ce' };
  if (tone === 'zs') return { color: '#0891b2', border: '#0e7490' };
  return { color: '#dc2626', border: '#991b1b' };
}
