import { useMemo, useState } from 'react';
import { Cable, ChevronRight, CircleDot, Home } from 'lucide-react';

import {
  filterMapTasks,
  getMapTaskGroups,
  getMapTaskRows,
  getMapTaskStageLabel,
  MAP_TASK_FILTER_LABELS,
  type MapTaskFilter,
  type MapTaskKind,
  type MapTaskRow,
  type MapTaskStageGroup,
  type MapTaskFolder,
} from '../map-task-list';
import { getCableStatusActions, getNodeStatusActions } from '../map-status-actions';
import type {
  ProjectMapCableStatus,
  ProjectMapData,
  ProjectMapNodeStatus,
} from '../types';
import { MapStatusActionButton } from './MapStatusControls';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

interface ProjectMapTasksProps {
  data: ProjectMapData;
  busyId: string | null;
  onCableStatusChange: (cableId: string, status: ProjectMapCableStatus) => void;
  onNodeStatusChange: (nodeId: string, status: ProjectMapNodeStatus) => void;
}

const FILTERS: MapTaskFilter[] = ['todo', 'progress', 'done', 'all'];

function TaskIcon({ kind }: { kind: MapTaskKind }) {
  if (kind === 'cable') return <Cable size={16} />;
  if (kind === 'address') return <Home size={16} />;
  return <CircleDot size={16} />;
}

function taskKindLabel(kind: MapTaskKind): string {
  if (kind === 'cable') return 'Kabel';
  if (kind === 'address') return 'Adres';
  return 'Punkt';
}

function stageClassName(stage: MapTaskRow['stage']): string {
  if (stage === 'done') return 'project-map-task-status--done';
  if (stage === 'progress') return 'project-map-task-status--progress';
  return 'project-map-task-status--todo';
}

function TaskKindIcon({ kind }: { kind: MapTaskKind }) {
  if (kind === 'cable') return <Cable size={15} />;
  if (kind === 'address') return <Home size={15} />;
  return <CircleDot size={15} />;
}

function TaskStatusActions({
  task,
  busyId,
  onCableStatusChange,
  onNodeStatusChange,
}: {
  task: MapTaskRow;
  busyId: string | null;
  onCableStatusChange: (cableId: string, status: ProjectMapCableStatus) => void;
  onNodeStatusChange: (nodeId: string, status: ProjectMapNodeStatus) => void;
}) {
  if (task.kind === 'cable' && task.cableStatus && task.routingType) {
    const actions = getCableStatusActions({ status: task.cableStatus, routingType: task.routingType });
    return (
      <div className="project-map-task__actions">
        {actions.map((action) => (
          <MapStatusActionButton
            key={action.status}
            action={action}
            disabled={busyId === task.sourceId || (action.kind === 'reset' && task.cableStatus === 'PENDING')}
            onSelect={(status) => onCableStatusChange(task.sourceId, status)}
          />
        ))}
      </div>
    );
  }

  if (task.kind === 'node' && task.nodeStatus) {
    const actions = getNodeStatusActions(task.nodeStatus);
    return (
      <div className="project-map-task__actions">
        {actions.map((action) => (
          <MapStatusActionButton
            key={action.status}
            action={action}
            disabled={busyId === task.sourceId || (action.kind === 'reset' && task.nodeStatus === 'PENDING')}
            onSelect={(status) => onNodeStatusChange(task.sourceId, status)}
          />
        ))}
      </div>
    );
  }

  return null;
}

function TaskRow({
  task,
  busyId,
  onCableStatusChange,
  onNodeStatusChange,
}: {
  task: MapTaskRow;
  busyId: string | null;
  onCableStatusChange: (cableId: string, status: ProjectMapCableStatus) => void;
  onNodeStatusChange: (nodeId: string, status: ProjectMapNodeStatus) => void;
}) {
  return (
    <article className="project-map-task">
      <div className="project-map-task__main">
        <div className="project-map-task__icon">
          <TaskIcon kind={task.kind} />
        </div>
        <div className="project-map-task__content">
          <div className="project-map-task__topline">
            <Badge variant="outline">{taskKindLabel(task.kind)}</Badge>
            <span className={`project-map-task-status ${stageClassName(task.stage)}`}>
              {getMapTaskStageLabel(task.stage)}
            </span>
          </div>
          <h3>{task.title}</h3>
          <p>{task.subtitle}</p>
          <div className="project-map-task__summary">
            <strong>{task.statusLabel}</strong>
            <span>{task.summary}</span>
          </div>
        </div>
      </div>

      <TaskStatusActions
        task={task}
        busyId={busyId}
        onCableStatusChange={onCableStatusChange}
        onNodeStatusChange={onNodeStatusChange}
      />
    </article>
  );
}

function TaskFolderView({
  folder,
  defaultOpen,
  busyId,
  onCableStatusChange,
  onNodeStatusChange,
}: {
  folder: MapTaskFolder;
  defaultOpen: boolean;
  busyId: string | null;
  onCableStatusChange: (cableId: string, status: ProjectMapCableStatus) => void;
  onNodeStatusChange: (nodeId: string, status: ProjectMapNodeStatus) => void;
}) {
  return (
    <details className="project-map-task-folder" open={defaultOpen}>
      <summary className="project-map-task-folder__summary">
        <span className="project-map-task-folder__chevron">
          <ChevronRight size={15} />
        </span>
        <span className="project-map-task-folder__icon">
          <TaskKindIcon kind={folder.kind} />
        </span>
        <span>{folder.label}</span>
        <strong>{folder.count}</strong>
      </summary>
      <div className="project-map-task-folder__rows">
        {folder.rows.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            busyId={busyId}
            onCableStatusChange={onCableStatusChange}
            onNodeStatusChange={onNodeStatusChange}
          />
        ))}
      </div>
    </details>
  );
}

function StageGroupView({
  group,
  busyId,
  onCableStatusChange,
  onNodeStatusChange,
}: {
  group: MapTaskStageGroup;
  busyId: string | null;
  onCableStatusChange: (cableId: string, status: ProjectMapCableStatus) => void;
  onNodeStatusChange: (nodeId: string, status: ProjectMapNodeStatus) => void;
}) {
  const hasTasks = group.count > 0;

  return (
    <details className="project-map-task-stage" open={group.stage !== 'done'}>
      <summary className="project-map-task-stage__summary">
        <span className="project-map-task-stage__chevron">
          <ChevronRight size={16} />
        </span>
        <span className={`project-map-task-status ${stageClassName(group.stage)}`}>
          {group.label}
        </span>
        <strong>{group.count}</strong>
      </summary>

      <div className="project-map-task-stage__content">
        {hasTasks ? (
          group.folders.map((folder) => (
            <TaskFolderView
              key={folder.kind}
              folder={folder}
              defaultOpen={false}
              busyId={busyId}
              onCableStatusChange={onCableStatusChange}
              onNodeStatusChange={onNodeStatusChange}
            />
          ))
        ) : (
          <div className="project-map-task-stage__empty">
            Nic tu nie ma.
          </div>
        )}
      </div>
    </details>
  );
}

export default function ProjectMapTasks({
  data,
  busyId,
  onCableStatusChange,
  onNodeStatusChange,
}: ProjectMapTasksProps) {
  const [filter, setFilter] = useState<MapTaskFilter>('all');
  const rows = useMemo(() => getMapTaskRows(data), [data]);
  const groups = useMemo(() => getMapTaskGroups(rows, filter), [rows, filter]);
  const visibleGroups = useMemo(
    () => groups.filter((group) => group.count > 0 || filter !== 'all'),
    [groups, filter],
  );
  const visibleRows = useMemo(() => filterMapTasks(rows, filter), [rows, filter]);
  const counts = useMemo(
    () => ({
      all: rows.length,
      todo: rows.filter((row) => row.stage === 'todo').length,
      progress: rows.filter((row) => row.stage === 'progress').length,
      done: rows.filter((row) => row.stage === 'done').length,
    }),
    [rows],
  );

  return (
    <div className="project-map-tasks">
      <div className="project-map-tasks__header">
        <div>
          <h2>Lista zadan z mapy</h2>
          <p>Kable, punkty i adresy wyliczone z aktualnych statusow mapy.</p>
        </div>
        <div className="project-map-tasks__filters" aria-label="Filtr zadan mapy">
          {FILTERS.map((nextFilter) => (
            <Button
              key={nextFilter}
              type="button"
              size="sm"
              variant={filter === nextFilter ? 'default' : 'outline'}
              onClick={() => setFilter(nextFilter)}
            >
              {MAP_TASK_FILTER_LABELS[nextFilter]} {counts[nextFilter]}
            </Button>
          ))}
        </div>
      </div>

      <div className="project-map-tasks__list">
        {visibleGroups.map((group) => (
          <StageGroupView
            key={group.stage}
            group={group}
            busyId={busyId}
            onCableStatusChange={onCableStatusChange}
            onNodeStatusChange={onNodeStatusChange}
          />
        ))}

        {visibleRows.length === 0 && (
          <div className="project-map-tasks__empty">
            Brak zadan w tym filtrze.
          </div>
        )}
      </div>
    </div>
  );
}
