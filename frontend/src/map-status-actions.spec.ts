import { describe, expect, it } from 'vitest';
import { getCableStatusActions, getNodeStatusActions } from './map-status-actions';

describe('map status actions', () => {
  it('shows underground cable work steps and a clear reset action', () => {
    const actions = getCableStatusActions({ status: 'DUCT_READY', routingType: 'underground' });

    expect(actions.map(({ status, label, kind, isActive }) => ({ status, label, kind, isActive }))).toEqual([
      { status: 'DUCT_READY', label: 'Rurociag', kind: 'progress', isActive: true },
      { status: 'PULLED', label: 'Zaciagniete', kind: 'complete', isActive: false },
      { status: 'PENDING', label: 'Reset', kind: 'reset', isActive: false },
    ]);
  });

  it('shows one ADSS action before reset', () => {
    const actions = getCableStatusActions({ status: 'SUSPENDED', routingType: 'aerial' });

    expect(actions.map(({ status, label, kind, isActive }) => ({ status, label, kind, isActive }))).toEqual([
      { status: 'SUSPENDED', label: 'Podwieszony', kind: 'complete', isActive: true },
      { status: 'PENDING', label: 'Reset', kind: 'reset', isActive: false },
    ]);
  });

  it('keeps two work steps for cables in existing ducts', () => {
    const actions = getCableStatusActions({ status: 'PENDING', routingType: 'existing_duct' });

    expect(actions.map(({ status, label, kind, isActive }) => ({ status, label, kind, isActive }))).toEqual([
      { status: 'DUCT_READY', label: 'Mikrorurka', kind: 'progress', isActive: false },
      { status: 'PULLED', label: 'Zaciagniete', kind: 'complete', isActive: false },
      { status: 'PENDING', label: 'Reset', kind: 'reset', isActive: false },
    ]);
  });

  it('shows node completion separately from reset', () => {
    const actions = getNodeStatusActions('WELDED');

    expect(actions.map(({ status, label, kind, isActive }) => ({ status, label, kind, isActive }))).toEqual([
      { status: 'WELDED', label: 'Wyspawane', kind: 'complete', isActive: true },
      { status: 'PENDING', label: 'Reset', kind: 'reset', isActive: false },
    ]);
  });
});
