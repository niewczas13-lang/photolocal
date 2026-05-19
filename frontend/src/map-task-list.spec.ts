import { describe, expect, it } from 'vitest';
import { filterMapTasks, getMapTaskGroups, getMapTaskRows } from './map-task-list';
import type { ProjectMapData } from './types';

function mapData(overrides: Partial<ProjectMapData> = {}): ProjectMapData {
  return {
    addresses: [
      {
        id: 'address-1',
        label: 'Ostrzeszewo 10',
        city: 'Ostrzeszewo',
        street: 'Ostrzeszewo',
        buildingNo: '10',
        distributionPoint: 'OSTRZESZEWO/OPP0002',
        lat: 53.75,
        lng: 20.55,
        reservePhotoCount: 0,
        hasReservePhoto: false,
        status: 'PENDING',
        isNotApplicable: false,
        photos: [],
      },
      {
        id: 'address-2',
        label: 'Klebark Maly 38',
        city: 'Klebark Maly',
        street: 'Klebark Maly',
        buildingNo: '38',
        distributionPoint: 'KLEBARK MALY/OPP0002',
        lat: 53.74,
        lng: 20.57,
        reservePhotoCount: 1,
        hasReservePhoto: true,
        status: 'COMPLETE',
        isNotApplicable: false,
        photos: [],
      },
    ],
    addressCandidates: [],
    polygons: [],
    trunkCables: [
      {
        id: 'cable-1',
        cableType: 'DAC 8J',
        fromNode: 'OSTRZESZEWO/ZS0001',
        toNode: 'OSTRZESZEWO/OPP0002',
        osdName: 'OSTRZESZEWO/OPP0002',
        geojson: { type: 'LineString', coordinates: [] },
        rawName: 'OKH0030737-BD/010',
        routingType: 'underground',
        status: 'DUCT_READY',
        routeLengthMeters: null,
        installationLengthMeters: null,
      },
      {
        id: 'cable-2',
        cableType: 'ADSS 12J',
        fromNode: 'KLEBARK MALY/ZS0002',
        toNode: 'KLEBARK MALY/OPP0002',
        osdName: 'KLEBARK MALY/OPP0002',
        geojson: { type: 'LineString', coordinates: [] },
        rawName: 'OKH0030737-BA/007',
        routingType: 'aerial',
        status: 'SUSPENDED',
        routeLengthMeters: null,
        installationLengthMeters: null,
      },
      {
        id: 'cable-3',
        cableType: 'MI-MKF 12J',
        fromNode: 'OSTRZESZEWO/ZS0003',
        toNode: 'OSTRZESZEWO/OPP0003',
        osdName: 'OSTRZESZEWO/OPP0003',
        geojson: { type: 'LineString', coordinates: [] },
        rawName: 'OKH0030737-IST/001',
        routingType: 'existing_duct',
        status: 'PENDING',
        routeLengthMeters: null,
        installationLengthMeters: null,
      },
    ],
    infraNodes: [
      {
        id: 'node-1',
        nodeType: 'OPP',
        name: 'OSTRZESZEWO/OPP0002',
        label: 'O_OSTRZESZEWO/OPP0002',
        lat: 53.75,
        lng: 20.55,
        status: 'WELDED',
        hasPhoto: false,
        photos: [],
      },
      {
        id: 'node-2',
        nodeType: 'OSD',
        name: 'KLEBARK MALY/OSD0001',
        label: 'O_KLEBARK MALY/OSD0001',
        lat: 53.74,
        lng: 20.57,
        status: 'PENDING',
        hasPhoto: false,
        photos: [],
      },
    ],
    notes: [],
    ...overrides,
  };
}

describe('map task list', () => {
  it('builds task rows from current cable, node, and address statuses', () => {
    const rows = getMapTaskRows(mapData());

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'cable-cable-1',
          kind: 'cable',
          title: 'OKH0030737-BD/010',
          statusLabel: 'Rurociag gotowy',
          stage: 'progress',
          summary: 'Rurociag wybudowany, kabel do zaciagniecia',
        }),
        expect.objectContaining({
          id: 'cable-cable-2',
          kind: 'cable',
          statusLabel: 'Podwieszony',
          stage: 'done',
          summary: 'Kabel podwieszony',
        }),
        expect.objectContaining({
          id: 'cable-cable-3',
          kind: 'cable',
          statusLabel: 'Do zrobienia',
          stage: 'todo',
          summary: 'Mikrorurka lub kabel do zaciagniecia w istniejacej kanalizacji',
        }),
        expect.objectContaining({
          id: 'node-node-1',
          kind: 'node',
          title: 'O_OSTRZESZEWO/OPP0002',
          statusLabel: 'Wyspawane',
          stage: 'done',
          summary: 'Punkt wyspawany',
        }),
        expect.objectContaining({
          id: 'address-address-1',
          kind: 'address',
          title: 'Ostrzeszewo 10',
          statusLabel: 'Brak zapasu',
          stage: 'todo',
          summary: 'Zapas do uzupelnienia',
        }),
      ]),
    );
  });

  it('filters task rows by visible work stage', () => {
    const rows = getMapTaskRows(mapData());

    expect(filterMapTasks(rows, 'all')).toHaveLength(rows.length);
    expect(filterMapTasks(rows, 'todo').map((row) => row.id)).toEqual([
      'cable-cable-3',
      'node-node-2',
      'address-address-1',
    ]);
    expect(filterMapTasks(rows, 'progress').map((row) => row.id)).toEqual(['cable-cable-1']);
    expect(filterMapTasks(rows, 'done').map((row) => row.id)).toEqual([
      'cable-cable-2',
      'node-node-1',
      'address-address-2',
    ]);
  });

  it('sorts tasks into collapsible stage and kind folders', () => {
    const rows = getMapTaskRows(
      mapData({
        trunkCables: [
          {
            id: 'cable-b',
            cableType: 'DAC 8J',
            fromNode: 'B/ZS0001',
            toNode: 'B/OPP0002',
            osdName: 'B/OPP0002',
            geojson: { type: 'LineString', coordinates: [] },
            rawName: 'OKH-010',
            routingType: 'underground',
            status: 'PENDING',
            routeLengthMeters: null,
            installationLengthMeters: null,
          },
          {
            id: 'cable-a',
            cableType: 'DAC 8J',
            fromNode: 'A/ZS0001',
            toNode: 'A/OPP0002',
            osdName: 'A/OPP0002',
            geojson: { type: 'LineString', coordinates: [] },
            rawName: 'OKH-002',
            routingType: 'underground',
            status: 'PENDING',
            routeLengthMeters: null,
            installationLengthMeters: null,
          },
        ],
      }),
    );

    expect(rows.map((row) => row.id).slice(0, 4)).toEqual([
      'cable-cable-a',
      'cable-cable-b',
      'node-node-2',
      'address-address-1',
    ]);

    const groups = getMapTaskGroups(rows, 'all');

    expect(groups.map((group) => [group.stage, group.count])).toEqual([
      ['todo', 4],
      ['progress', 0],
      ['done', 2],
    ]);
    expect(groups[0].folders.map((folder) => [folder.kind, folder.count])).toEqual([
      ['cable', 2],
      ['node', 1],
      ['address', 1],
    ]);
    expect(groups[0].folders[0].rows.map((row) => row.title)).toEqual(['OKH-002', 'OKH-010']);
  });

  it('counts addresses marked as not applicable as completed work', () => {
    const rows = getMapTaskRows(
      mapData({
        addresses: [
          {
            id: 'address-skip',
            label: 'Polna 15',
            city: 'Radom',
            street: 'Polna',
            buildingNo: '15',
            distributionPoint: 'RADOM/OSD0001',
            lat: 51.4,
            lng: 21.1,
            reservePhotoCount: 0,
            hasReservePhoto: false,
            status: 'NOT_APPLICABLE',
            isNotApplicable: true,
            photos: [],
          },
        ],
      }),
    );

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'address-address-skip',
          statusLabel: 'Nie dotyczy',
          summary: 'Adres oznaczony jako nie dotyczy',
          stage: 'done',
        }),
      ]),
    );
  });
});
