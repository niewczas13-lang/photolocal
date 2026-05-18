import { describe, expect, it } from 'vitest';
import { getCableLineStyle, getMarkerTone, isCableReady } from './map-style';

describe('map styling', () => {
  it('uses distinct line styles for underground and aerial cables', () => {
    expect(getCableLineStyle('PENDING', 'underground')).toMatchObject({
      color: '#b45309',
      dashArray: undefined,
    });
    expect(getCableLineStyle('PENDING', 'aerial')).toMatchObject({
      color: '#2563eb',
      dashArray: '8 6',
    });
    expect(getCableLineStyle('DUCT_READY', 'underground')).toMatchObject({
      color: '#ca8a04',
      dashArray: undefined,
    });
    expect(getCableLineStyle('PULLED', 'underground')).toMatchObject({
      color: '#15803d',
      dashArray: undefined,
    });
    expect(getCableLineStyle('SUSPENDED', 'aerial')).toMatchObject({
      color: '#15803d',
      dashArray: '8 6',
    });
  });

  it('uses distinct pending colors for passive node types', () => {
    expect(getMarkerTone({ nodeType: 'OSD', status: 'PENDING', hasPhoto: false })).toBe('osd');
    expect(getMarkerTone({ nodeType: 'OPP', status: 'PENDING', hasPhoto: false })).toBe('opp');
    expect(getMarkerTone({ nodeType: 'ZS', status: 'PENDING', hasPhoto: false })).toBe('zs');
    expect(getMarkerTone({ nodeType: 'OSD', status: 'WELDED', hasPhoto: false })).toBe('done');
  });

  it('counts suspended ADSS and pulled duct cables as ready', () => {
    expect(isCableReady('PENDING')).toBe(false);
    expect(isCableReady('DUCT_READY')).toBe(false);
    expect(isCableReady('PULLED')).toBe(true);
    expect(isCableReady('SUSPENDED')).toBe(true);
  });
});
