import type {
  ProjectMapCableRoutingType,
  ProjectMapCableStatus,
  ProjectMapNodeStatus,
} from './types';

export type MapStatusActionKind = 'progress' | 'complete' | 'reset';

export const STATUS_LABELS: Record<ProjectMapCableStatus | ProjectMapNodeStatus, string> = {
  PENDING: 'Do zrobienia',
  DUCT_READY: 'Rurociag gotowy',
  PULLED: 'Zaciagniete',
  WELDED: 'Wyspawane',
  SUSPENDED: 'Podwieszony',
};

export interface MapStatusAction<TStatus extends string> {
  status: TStatus;
  label: string;
  kind: MapStatusActionKind;
  isActive: boolean;
  ariaLabel: string;
}

export function getCableStatusActions(input: {
  status: ProjectMapCableStatus;
  routingType: ProjectMapCableRoutingType;
}): MapStatusAction<ProjectMapCableStatus>[] {
  const ductAction =
    input.routingType === 'existing_duct'
      ? {
          status: 'DUCT_READY' as const,
          label: 'Mikrorurka',
          kind: 'progress' as const,
          ariaLabel: 'Oznacz mikrorurke jako zaciagnieta',
        }
      : {
          status: 'DUCT_READY' as const,
          label: 'Rurociag',
          kind: 'progress' as const,
          ariaLabel: 'Oznacz rurociag jako gotowy',
        };
  const workflowActions: Array<Omit<MapStatusAction<ProjectMapCableStatus>, 'isActive'>> =
    input.routingType === 'aerial'
      ? [
          {
            status: 'SUSPENDED',
            label: 'Podwieszony',
            kind: 'complete',
            ariaLabel: 'Oznacz kabel jako podwieszony',
          },
        ]
      : [
          ductAction,
          {
            status: 'PULLED',
            label: 'Zaciagniete',
            kind: 'complete',
            ariaLabel: 'Oznacz kabel jako zaciagniety',
          },
        ];

  const resetAction: Omit<MapStatusAction<ProjectMapCableStatus>, 'isActive'> = {
    status: 'PENDING',
    label: 'Reset',
    kind: 'reset',
    ariaLabel: 'Resetuj status kabla',
  };
  const actions: Array<Omit<MapStatusAction<ProjectMapCableStatus>, 'isActive'>> = [
    ...workflowActions,
    resetAction,
  ];

  return actions.map((action) => ({
    ...action,
    isActive: action.status === input.status && action.kind !== 'reset',
  }));
}

export function getNodeStatusActions(
  status: ProjectMapNodeStatus,
): MapStatusAction<ProjectMapNodeStatus>[] {
  return [
    {
      status: 'WELDED',
      label: 'Wyspawane',
      kind: 'complete',
      isActive: status === 'WELDED',
      ariaLabel: 'Oznacz punkt jako wyspawany',
    },
    {
      status: 'PENDING',
      label: 'Reset',
      kind: 'reset',
      isActive: false,
      ariaLabel: 'Resetuj status punktu',
    },
  ];
}
