import type {
  ProjectMapAddress,
  ProjectMapCable,
  ProjectMapCableStatus,
  ProjectMapData,
  ProjectMapInfraNode,
  ProjectMapNodeStatus,
} from './types';

export type MapTaskKind = 'cable' | 'node' | 'address';
export type MapTaskStage = 'todo' | 'progress' | 'done';
export type MapTaskFilter = MapTaskStage | 'all';

const TASK_STAGE_ORDER: MapTaskStage[] = ['todo', 'progress', 'done'];
const TASK_KIND_ORDER: MapTaskKind[] = ['cable', 'node', 'address'];
const COLLATOR = new Intl.Collator('pl', { numeric: true, sensitivity: 'base' });

export interface MapTaskRow {
  id: string;
  sourceId: string;
  kind: MapTaskKind;
  title: string;
  subtitle: string;
  statusLabel: string;
  summary: string;
  stage: MapTaskStage;
  cableStatus?: ProjectMapCableStatus;
  nodeStatus?: ProjectMapNodeStatus;
  routingType?: ProjectMapCable['routingType'];
}

export interface MapTaskFolder {
  kind: MapTaskKind;
  label: string;
  count: number;
  rows: MapTaskRow[];
}

export interface MapTaskStageGroup {
  stage: MapTaskStage;
  label: string;
  count: number;
  folders: MapTaskFolder[];
}

export const MAP_TASK_FILTER_LABELS: Record<MapTaskFilter, string> = {
  all: 'Wszystkie',
  todo: 'Do zrobienia',
  progress: 'W trakcie',
  done: 'Gotowe',
};

export const MAP_TASK_KIND_LABELS: Record<MapTaskKind, string> = {
  cable: 'Kable',
  node: 'Punkty',
  address: 'Adresy',
};

export function getMapTaskStageLabel(stage: MapTaskStage): string {
  if (stage === 'progress') return 'W trakcie';
  if (stage === 'done') return 'Gotowe';
  return 'Do zrobienia';
}

function compareTaskRows(a: MapTaskRow, b: MapTaskRow): number {
  const stageOrder = TASK_STAGE_ORDER.indexOf(a.stage) - TASK_STAGE_ORDER.indexOf(b.stage);
  if (stageOrder !== 0) return stageOrder;

  const kindOrder = TASK_KIND_ORDER.indexOf(a.kind) - TASK_KIND_ORDER.indexOf(b.kind);
  if (kindOrder !== 0) return kindOrder;

  const titleOrder = COLLATOR.compare(a.title, b.title);
  if (titleOrder !== 0) return titleOrder;

  return COLLATOR.compare(a.subtitle, b.subtitle);
}

function getCableStatusDetails(cable: ProjectMapCable): {
  statusLabel: string;
  summary: string;
  stage: MapTaskStage;
} {
  if (cable.status === 'DUCT_READY') {
    return {
      statusLabel: 'Rurociag gotowy',
      summary: 'Rurociag wybudowany, kabel do zaciagniecia',
      stage: 'progress',
    };
  }

  if (cable.status === 'PULLED' || cable.status === 'WELDED') {
    return {
      statusLabel: 'Zaciagniete',
      summary: 'Kabel zaciagniety',
      stage: 'done',
    };
  }

  if (cable.status === 'SUSPENDED') {
    return {
      statusLabel: 'Podwieszony',
      summary: 'Kabel podwieszony',
      stage: 'done',
    };
  }

  return {
    statusLabel: 'Do zrobienia',
    summary: cable.routingType === 'aerial' ? 'Kabel do podwieszenia' : 'Rurociag i kabel do wykonania',
    stage: 'todo',
  };
}

function cableTask(cable: ProjectMapCable): MapTaskRow {
  const details = getCableStatusDetails(cable);
  return {
    id: `cable-${cable.id}`,
    sourceId: cable.id,
    kind: 'cable',
    title: cable.rawName ?? `${cable.fromNode} - ${cable.toNode}`,
    subtitle: `${cable.fromNode} -> ${cable.toNode} · ${cable.routingType === 'aerial' ? 'napowietrzny' : 'doziemny'}`,
    cableStatus: cable.status,
    routingType: cable.routingType,
    ...details,
  };
}

function nodeTask(node: ProjectMapInfraNode): MapTaskRow {
  const isDone = node.status === 'WELDED' || node.hasPhoto;
  return {
    id: `node-${node.id}`,
    sourceId: node.id,
    kind: 'node',
    title: node.label ?? node.name,
    subtitle: `${node.nodeType} · ${node.name}`,
    statusLabel: isDone ? (node.hasPhoto && node.status !== 'WELDED' ? 'Jest zdjecie' : 'Wyspawane') : 'Do zrobienia',
    summary: isDone ? 'Punkt wyspawany' : 'Punkt do spawania',
    stage: isDone ? 'done' : 'todo',
    nodeStatus: node.status,
  };
}

function addressTask(address: ProjectMapAddress): MapTaskRow {
  return {
    id: `address-${address.id}`,
    sourceId: address.id,
    kind: 'address',
    title: address.label,
    subtitle: address.distributionPoint ?? 'Bez punktu dystrybucyjnego',
    statusLabel: address.hasReservePhoto ? 'Zapas jest' : 'Brak zapasu',
    summary: address.hasReservePhoto ? 'Zapas uzupelniony' : 'Zapas do uzupelnienia',
    stage: address.hasReservePhoto ? 'done' : 'todo',
  };
}

export function getMapTaskRows(data: ProjectMapData): MapTaskRow[] {
  return [
    ...data.trunkCables.map(cableTask),
    ...data.infraNodes.map(nodeTask),
    ...data.addresses.map(addressTask),
  ].sort(compareTaskRows);
}

export function filterMapTasks(rows: MapTaskRow[], filter: MapTaskFilter): MapTaskRow[] {
  if (filter === 'all') return rows;
  return rows.filter((row) => row.stage === filter);
}

export function getMapTaskGroups(rows: MapTaskRow[], filter: MapTaskFilter): MapTaskStageGroup[] {
  const visibleRows = filterMapTasks(rows, filter);
  const stages = filter === 'all' ? TASK_STAGE_ORDER : [filter];

  return stages.map((stage) => {
    const stageRows = visibleRows.filter((row) => row.stage === stage);
    const folders = TASK_KIND_ORDER.map((kind) => {
      const folderRows = stageRows.filter((row) => row.kind === kind);
      return {
        kind,
        label: MAP_TASK_KIND_LABELS[kind],
        count: folderRows.length,
        rows: folderRows,
      };
    }).filter((folder) => folder.count > 0);

    return {
      stage,
      label: getMapTaskStageLabel(stage),
      count: stageRows.length,
      folders,
    };
  });
}
