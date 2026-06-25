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
    if (cable.routingType === 'existing_duct') {
      return {
        statusLabel: 'Mikrorurka gotowa',
        summary: 'Mikrorurka wciagnieta, kabel do zaciagniecia',
        stage: 'progress',
      };
    }

    return {
      statusLabel: 'Rurociag gotowy',
      summary: 'Rurociag wybudowany, kabel do zaciagniecia',
      stage: 'progress',
    };
  }

  if (cable.status === 'PULLED' || cable.status === 'WELDED') {
    if (cable.status === 'PULLED' && cable.routingType === 'existing_duct') {
      return {
        statusLabel: 'Wdmuchniety kabel',
        summary: 'Kabel wdmuchniety do mikrorurki',
        stage: 'done',
      };
    }

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
    summary:
      cable.routingType === 'aerial'
        ? 'Kabel do podwieszenia'
        : cable.routingType === 'existing_duct'
          ? 'Mikrorurka lub kabel do zaciagniecia w istniejacej kanalizacji'
          : 'Rurociag i kabel do wykonania',
    stage: 'todo',
  };
}

function cableTask(cable: ProjectMapCable): MapTaskRow {
  const details = getCableStatusDetails(cable);
  const routeLabel =
    cable.routingType === 'aerial'
      ? 'napowietrzny'
      : cable.routingType === 'existing_duct'
        ? 'istniejaca kanalizacja'
        : 'doziemny';
  return {
    id: `cable-${cable.id}`,
    sourceId: cable.id,
    kind: 'cable',
    title: cable.rawName ?? `${cable.fromNode} - ${cable.toNode}`,
    subtitle: `${cable.fromNode} -> ${cable.toNode} · ${routeLabel}`,
    cableStatus: cable.status,
    routingType: cable.routingType,
    ...details,
  };
}

function nodeTask(node: ProjectMapInfraNode): MapTaskRow {
  const isDone = node.status === 'WELDED';
  const isProgress = !isDone && node.hasPhoto;
  return {
    id: `node-${node.id}`,
    sourceId: node.id,
    kind: 'node',
    title: node.label ?? node.name,
    subtitle: `${node.nodeType} · ${node.name}`,
    statusLabel: isDone ? 'Wyspawane' : isProgress ? 'Jest zdjecie' : 'Do zrobienia',
    summary: isDone ? 'Punkt wyspawany' : isProgress ? 'Zdjecie dodane, spaw do potwierdzenia' : 'Punkt do spawania',
    stage: isDone ? 'done' : isProgress ? 'progress' : 'todo',
    nodeStatus: node.status,
  };
}

function addressTask(address: ProjectMapAddress): MapTaskRow {
  const isDone = address.hasReservePhoto || address.isNotApplicable;
  const isAerialCoveredByDistribution =
    address.usesDistributionPhotoForCompletion && address.hasDistributionPhoto && address.reservePhotoCount === 0;
  const statusLabel = address.isNotApplicable
    ? 'Nie dotyczy'
    : isAerialCoveredByDistribution
      ? 'OSD/OPP jest'
      : address.hasReservePhoto
        ? 'Zapas jest'
        : address.usesDistributionPhotoForCompletion
          ? 'Napowietrzny'
          : 'Brak zapasu';
  const summary = address.isNotApplicable
    ? 'Adres oznaczony jako nie dotyczy'
    : isAerialCoveredByDistribution
      ? 'Adres napowietrzny potwierdzony zdjeciem punktu'
      : address.hasReservePhoto
        ? 'Zapas uzupelniony'
        : address.usesDistributionPhotoForCompletion
          ? 'Adres napowietrzny czeka na zdjecie OSD/OPP'
          : 'Zapas do uzupelnienia';

  return {
    id: `address-${address.id}`,
    sourceId: address.id,
    kind: 'address',
    title: address.label,
    subtitle: address.distributionPoint ?? 'Bez punktu dystrybucyjnego',
    statusLabel,
    summary,
    stage: isDone ? 'done' : 'todo',
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
