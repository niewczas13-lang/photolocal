import { CheckCircle2, RotateCcw, Wrench } from 'lucide-react';

import { cn } from '../lib/utils';
import type {
  MapStatusAction,
  MapStatusActionKind,
} from '../map-status-actions';
import type { ProjectMapCableStatus, ProjectMapNodeStatus } from '../types';
import { Button } from './ui/button';

function StatusActionIcon({ kind }: { kind: MapStatusActionKind }) {
  if (kind === 'reset') return <RotateCcw size={14} />;
  if (kind === 'progress') return <Wrench size={14} />;
  return <CheckCircle2 size={14} />;
}

export function MapStatusActionButton<TStatus extends ProjectMapCableStatus | ProjectMapNodeStatus>({
  action,
  disabled,
  onSelect,
}: {
  action: MapStatusAction<TStatus>;
  disabled: boolean;
  onSelect: (status: TStatus) => void;
}) {
  return (
    <Button
      size="sm"
      variant={action.kind === 'reset' ? 'ghost' : 'outline'}
      aria-pressed={action.isActive}
      aria-label={action.ariaLabel}
      disabled={disabled}
      className={cn(
        'project-map-status-button',
        `project-map-status-button--${action.kind}`,
        action.isActive && 'project-map-status-button--active',
      )}
      onClick={() => onSelect(action.status)}
    >
      <StatusActionIcon kind={action.kind} />
      <span>{action.label}</span>
    </Button>
  );
}
