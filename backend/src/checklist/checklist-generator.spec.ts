import { describe, expect, it } from 'vitest';
import { generateChecklistNodes } from './checklist-generator.js';

const baseAddress = {
  id: 'addr-1',
  city: 'Radom',
  street: 'Wronckiej',
  buildingNo: '13',
  propertyId: 'P1',
  parcelNumber: null,
  distributionPoint: 'OSD2640',
  lat: null,
  lng: null,
  householdCount: 0,
  businessUnitCount: 0,
};

describe('generateChecklistNodes', () => {
  it('creates top-level OSD folder with details child', () => {
    const nodes = generateChecklistNodes({
      projectId: 'project-1',
      projectName: 'Projekt',
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      addresses: [{ ...baseAddress, distributionPoint: 'KLEBARK MALY/OSD0007' }],
      dacToAddressCableEntries: ['WRONCKIEJ 13'],
      adssToAddressCableEntries: [],
    });

    expect(nodes.some((node) => node.path === 'OSD0007')).toBe(true);
    expect(nodes.some((node) => node.path === 'OSD0007/Szczegoly_skrzynki')).toBe(true);
    expect(nodes.some((node) => node.path === 'Zapasy_kabli_instalacyjnych/OSD0007/WRONCKIEJ_13')).toBe(true);
  });

  it('generates underground cable reserves for SI projects', () => {
    const nodes = generateChecklistNodes({
      projectId: 'project-1',
      projectName: 'Projekt',
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      addresses: [baseAddress],
      dacToAddressCableEntries: ['WRONCKIEJ 13'],
      adssToAddressCableEntries: [],
    });

    expect(nodes.some((node) => node.path === 'Zapasy_kabli_instalacyjnych')).toBe(true);
    expect(nodes.some((node) => node.path === 'Zapasy_kabli_instalacyjnych/OSD2640/WRONCKIEJ_13')).toBe(true);
    expect(nodes.some((node) => node.path.startsWith('Zapasy_kabli_napowietrznych'))).toBe(false);
  });

  it('generates aerial cable reserves for KPO projects', () => {
    const nodes = generateChecklistNodes({
      projectId: 'project-1',
      projectName: 'Projekt',
      projectType: 'KPO',
      splitterTopology: 'CASCADE',
      addresses: [baseAddress],
      dacToAddressCableEntries: ['WRONCKIEJ 13'],
      adssToAddressCableEntries: ['WRONCKIEJ 13'],
    });

    expect(nodes.some((node) => node.path === 'Zapasy_kabli_napowietrznych')).toBe(true);
    expect(nodes.some((node) => node.path === 'Zapasy_kabli_napowietrznych/OSD2640/WRONCKIEJ_13')).toBe(true);
  });

  it('does not drop address nodes when cable entries contain OSD names instead of address names', () => {
    const nodes = generateChecklistNodes({
      projectId: 'project-1',
      projectName: 'Projekt',
      projectType: 'KPO',
      splitterTopology: 'CASCADE',
      addresses: [
        { ...baseAddress, id: 'addr-1', street: 'Klebark Maly', buildingNo: '1', distributionPoint: 'KLEBARK MALY/OSD0007' },
        { ...baseAddress, id: 'addr-2', street: 'Klebark Maly', buildingNo: '42', distributionPoint: 'KLEBARK MALY/OSD0007' },
      ],
      dacToAddressCableEntries: ['KLEBARK MALY/OSD0007'],
      adssToAddressCableEntries: ['KLEBARK MALY/OSD0007'],
    });

    expect(nodes.some((node) => node.path === 'Zapasy_kabli_instalacyjnych/OSD0007/KLEBARK_MALY_1')).toBe(true);
    expect(nodes.some((node) => node.path === 'Zapasy_kabli_instalacyjnych/OSD0007/KLEBARK_MALY_42')).toBe(true);
    expect(nodes.some((node) => node.path === 'Zapasy_kabli_napowietrznych/OSD0007/KLEBARK_MALY_1')).toBe(true);
    expect(nodes.some((node) => node.path === 'Zapasy_kabli_napowietrznych/OSD0007/KLEBARK_MALY_42')).toBe(true);
  });

  it('uses OPP and OSD power measurement buckets for cascade topology', () => {
    const nodes = generateChecklistNodes({
      projectId: 'project-1',
      projectName: 'Projekt',
      projectType: 'KPO',
      splitterTopology: 'CASCADE',
      addresses: [
        { ...baseAddress, id: 'addr-1', distributionPoint: 'OPP1394' },
        { ...baseAddress, id: 'addr-2', distributionPoint: 'OSD2640' },
      ],
      dacToAddressCableEntries: ['WRONCKIEJ 13'],
      adssToAddressCableEntries: [],
    });

    expect(nodes.some((node) => node.path === 'Pomiary_mocy/OPP1394')).toBe(true);
    expect(nodes.some((node) => node.path === 'Pomiary_mocy/OSD2640')).toBe(true);
  });
});
