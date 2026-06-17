import { describe, expect, it } from 'vitest';
import {
  getCableLineStyle,
  getCableLineStyles,
  getAddressMarkerTone,
  getMarkerTone,
  getMarkerToneStyle,
  isCableReady,
  isNodeReady,
} from './map-style';

describe('map styling', () => {
  it('uses distinct dashed line styles for each cable route and work stage', () => {
    expect(getCableLineStyle('PENDING', 'underground')).toMatchObject({
      color: '#92400e',
      dashArray: '8 16',
    });
    expect(getCableLineStyle('PENDING', 'aerial')).toMatchObject({
      color: '#2563eb',
      dashArray: '8 16',
    });
    expect(getCableLineStyle('PENDING', 'existing_duct')).toMatchObject({
      color: '#7c3aed',
      dashArray: '8 16',
    });
    expect(getCableLineStyle('DUCT_READY', 'underground')).toMatchObject({
      color: '#92400e',
      dashArray: '8 16',
    });
    expect(getCableLineStyle('PULLED', 'underground')).toMatchObject({
      color: '#92400e',
      dashArray: '8 16',
    });
    expect(getCableLineStyle('SUSPENDED', 'aerial')).toMatchObject({
      color: '#2563eb',
      dashArray: '8 16',
    });
  });

  it('adds alternating overlay dashes for partially and fully completed cable stages', () => {
    expect(getCableLineStyles('SUSPENDED', 'aerial')).toEqual([
      expect.objectContaining({ color: '#2563eb', dashArray: '8 16' }),
      expect.objectContaining({ color: '#22c55e', dashArray: '8 16', dashOffset: '8' }),
    ]);
    expect(getCableLineStyles('DUCT_READY', 'existing_duct')).toEqual([
      expect.objectContaining({ color: '#7c3aed', dashArray: '8 16' }),
      expect.objectContaining({ color: '#f97316', dashArray: '8 16', dashOffset: '8' }),
    ]);
    expect(getCableLineStyles('PULLED', 'existing_duct')).toEqual([
      expect.objectContaining({ color: '#7c3aed', dashArray: '8 16' }),
      expect.objectContaining({ color: '#22c55e', dashArray: '8 16', dashOffset: '8' }),
    ]);
    expect(getCableLineStyles('DUCT_READY', 'underground')).toEqual([
      expect.objectContaining({ color: '#92400e', dashArray: '8 16' }),
      expect.objectContaining({ color: '#f97316', dashArray: '8 16', dashOffset: '8' }),
    ]);
    expect(getCableLineStyles('PULLED', 'underground')).toEqual([
      expect.objectContaining({ color: '#92400e', dashArray: '8 16' }),
      expect.objectContaining({ color: '#22c55e', dashArray: '8 16', dashOffset: '8' }),
    ]);
  });

  it('uses distinct pending colors for passive node types', () => {
    expect(getMarkerTone({ nodeType: 'OSD', status: 'PENDING', hasPhoto: false })).toBe('osd');
    expect(getMarkerTone({ nodeType: 'OPP', status: 'PENDING', hasPhoto: false })).toBe('opp');
    expect(getMarkerTone({ nodeType: 'ZS', status: 'PENDING', hasPhoto: false })).toBe('zs');
    expect(getMarkerTone({ nodeType: 'OSD', status: 'WELDED', hasPhoto: false })).toBe('done');
  });

  it('shows passive nodes with photos as in progress until welding is confirmed', () => {
    const tone = getMarkerTone({ nodeType: 'OSD', status: 'PENDING', hasPhoto: true });

    expect(tone).toBe('nodePhoto');
    expect(getMarkerToneStyle(tone)).toMatchObject({
      color: '#f97316',
      border: '#c2410c',
    });
    expect(getMarkerTone({ nodeType: 'OSD', status: 'WELDED', hasPhoto: true })).toBe('done');
  });

  it('counts suspended ADSS and pulled duct cables as ready', () => {
    expect(isCableReady('PENDING')).toBe(false);
    expect(isCableReady('DUCT_READY')).toBe(false);
    expect(isCableReady('PULLED')).toBe(true);
    expect(isCableReady('SUSPENDED')).toBe(true);
  });

  it('does not count passive node photos as welded work', () => {
    expect(isNodeReady('PENDING', true)).toBe(false);
    expect(isNodeReady('WELDED', false)).toBe(true);
  });

  it('uses gray for map addresses marked as not applicable', () => {
    expect(
      getAddressMarkerTone({
        hasReservePhoto: false,
        isNotApplicable: true,
        isManuallyAdded: true,
      }),
    ).toBe('notApplicable');
    expect(getMarkerToneStyle('notApplicable')).toMatchObject({
      color: '#94a3b8',
    });
  });

  it('uses striped manual address tones until and after reserve photos arrive', () => {
    expect(
      getAddressMarkerTone({
        hasReservePhoto: false,
        isNotApplicable: false,
        isManuallyAdded: true,
      }),
    ).toBe('manualAddressPending');
    expect(getMarkerToneStyle('manualAddressPending')).toMatchObject({
      color: '#fb923c',
      border: '#991b1b',
      background: expect.stringContaining('#dc2626'),
    });

    expect(
      getAddressMarkerTone({
        hasReservePhoto: true,
        isNotApplicable: false,
        isManuallyAdded: true,
      }),
    ).toBe('manualAddressDone');
    expect(getMarkerToneStyle('manualAddressDone')).toMatchObject({
      color: '#fb923c',
      border: '#166534',
      background: expect.stringContaining('#16a34a'),
    });
  });
});
