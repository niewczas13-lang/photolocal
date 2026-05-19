import { describe, expect, it } from 'vitest';

import {
  getInfrastructureLineStyle,
  getInfrastructurePointIconSpec,
} from './map-infrastructure-style';

describe('infrastructure map styling', () => {
  it('draws ducts as darker quiet dashed background lines', () => {
    expect(getInfrastructureLineStyle()).toMatchObject({
      color: '#334155',
      dashArray: '4 7',
      opacity: 0.62,
      weight: 2,
    });
  });

  it('uses a small electric pole icon instead of a large point marker', () => {
    const icon = getInfrastructurePointIconSpec('pole');

    expect(icon.className).toContain('project-map-infra-point-icon');
    expect(icon.html).toContain('project-map-infra-pole');
    expect(icon.html).toContain('project-map-infra-pole__label');
    expect(icon.iconSize).toEqual([18, 26]);
  });

  it('keeps manholes visually smaller than the old infrastructure dots', () => {
    const icon = getInfrastructurePointIconSpec('manhole');

    expect(icon.html).toContain('project-map-infra-manhole');
    expect(icon.iconSize).toEqual([14, 14]);
  });
});
