import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import wkx from 'wkx';
import { extractGpkg, inferSplitterTopology, normalizeCableAddressEntry } from './gpkg-extractor.js';

function gpkgGeometry(wkb: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header[0] = 0x47;
  header[1] = 0x50;
  header[2] = 0;
  header[3] = 0;
  header.writeInt32LE(2180, 4);
  return Buffer.concat([header, wkb]);
}

function pointGeometry(x: number, y: number): Buffer {
  return gpkgGeometry(new wkx.Point(x, y).toWkb());
}

function lineGeometry(points: Array<[number, number]>): Buffer {
  return gpkgGeometry(
    new wkx.LineString(points.map(([x, y]) => new wkx.Point(x, y))).toWkb(),
  );
}

function polygonGeometry(points: Array<[number, number]>): Buffer {
  return gpkgGeometry(
    new wkx.Polygon(points.map(([x, y]) => new wkx.Point(x, y))).toWkb(),
  );
}

describe('GPKG extractor helpers', () => {
  it('marks more than two splitters as cascade', () => {
    expect(inferSplitterTopology(3)).toBe('CASCADE');
    expect(inferSplitterTopology(4)).toBe('CASCADE');
  });

  it('marks two or fewer splitters as single', () => {
    expect(inferSplitterTopology(0)).toBe('SINGLE');
    expect(inferSplitterTopology(1)).toBe('SINGLE');
    expect(inferSplitterTopology(2)).toBe('SINGLE');
  });

  it('normalizes cable destination address into the same format as checklist matching', () => {
    expect(normalizeCableAddressEntry('RADOM, UL. WRONCKIEJ, 13')).toBe('WRONCKIEJ 13');
    expect(normalizeCableAddressEntry('OSTRZESZEWO, 22')).toBe('OSTRZESZEWO 22');
  });

  it('includes only ZS mufas with projected splices in the non-plan fiber layer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-gpkg-splices-'));
    const gpkgPath = join(dir, 'sample.gpkg');
    const db = new Database(gpkgPath);

    db.exec(`
      CREATE TABLE PA (
        id_posesja_opl TEXT,
        nazwa_miejsc TEXT,
        nazwa_ul TEXT,
        nr_domu TEXT,
        nr_dzialki TEXT
      );
      INSERT INTO PA VALUES ('1', 'Bartag', 'Testowa', '1', '1/1');

      CREATE TABLE "_Urządzenia Pasywne" (
        wezel TEXT,
        oznaczenie TEXT,
        typ_elementu TEXT,
        model_urzadzenia TEXT,
        modyfikacja TEXT
      );
      INSERT INTO "_Urządzenia Pasywne" VALUES
        ('BARTAG/ZS00028', 'O_BARTAG/ZS00028', 'Mufa złączowa', 'FIST', NULL),
        ('BARTAG/ZS00029', 'O_BARTAG/ZS00029', 'Mufa złączowa', 'FIST', NULL),
        ('BARTAG/ZS00030', 'O_BARTAG/ZS00030', 'Mufa złączowa', 'FIST', NULL),
        ('BARTAG/ZS00031', 'O_BARTAG/ZS00031', 'Mufa złączowa', 'FIST', NULL),
        ('BARTAG/ZS00032', 'O_BARTAG/ZS00032', 'Mufa złączowa', 'FIST', NULL),
        ('BARTAG/ZS00033', 'O_BARTAG/ZS00033', 'Mufa złączowa', 'FIST', NULL),
        ('BARTAG/ZS00034', 'O_BARTAG/ZS00034', 'Mufa złączowa', 'FIST', NULL);

      CREATE TABLE "Włókna" (
        wezel_pocz TEXT,
        oznaczenie_urzadzenia_pocz TEXT,
        typ_polaczenia_pocz TEXT,
        pigtail_pocz_spaw TEXT,
        wezel_kon TEXT,
        oznaczenie_urzadzenia_kon TEXT,
        typ_polaczenia_kon TEXT,
        pigtail_kon_spaw TEXT
      );
      INSERT INTO "Włókna" VALUES
        ('BARTAG/ZS00033', 'O_BARTAG/ZS00033', 'Spaw termiczny projektowany', '', 'BARTAG/OPP0049', 'O_BARTAG/OPP0049', 'Złączka projektowana', 'Spaw termiczny projektowany');

      CREATE TABLE "_Włókna" (
        wezel_pocz TEXT,
        oznaczenie_urzadzenia_pocz TEXT,
        typ_polaczenia_pocz TEXT,
        pigtail_pocz_spaw TEXT,
        wezel_kon TEXT,
        oznaczenie_urzadzenia_kon TEXT,
        typ_polaczenia_kon TEXT,
        pigtail_kon_spaw TEXT
      );
      INSERT INTO "_Włókna" VALUES
        ('BARTAG/ZS00028', 'O_BARTAG/ZS00028', 'Spaw termiczny', '', 'BARTAG/OPP0049', 'O_BARTAG/OPP0049', 'Złączka', 'Spaw termiczny'),
        ('BARTAG/ZS00034', 'O_BARTAG/ZS00034', 'Spaw termiczny', '', 'BARTAG/OPP0047', 'O_BARTAG/OPP0047', 'Złączka', 'Spaw termiczny');
    `);
    db.close();

    const result = extractGpkg(gpkgPath);

    expect(result.splices).toEqual([{ wezel: 'BARTAG/ZS00033', oznaczenie: 'O_BARTAG/ZS00033' }]);
  });

  it('extracts address coordinates and map geometry from GPKG layers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-gpkg-map-'));
    const gpkgPath = join(dir, 'sample.gpkg');
    const db = new Database(gpkgPath);

    db.exec(`
      CREATE TABLE PA (
        id_posesja_opl TEXT,
        nazwa_miejsc TEXT,
        nazwa_ul TEXT,
        nr_domu TEXT,
        nr_dzialki TEXT,
        geom BLOB
      );
      CREATE TABLE Lokale (
        id_posesja_opl TEXT,
        opp_osd TEXT,
        nr_lokalu TEXT
      );
      CREATE TABLE Rejonizacja (
        rejonizacja TEXT,
        liczba_hh INTEGER,
        liczba_pa INTEGER,
        nr_kabla TEXT,
        geom BLOB
      );
      CREATE TABLE "Kable Swiatlowodowe" (
        model_kabla TEXT,
        typ_elementu TEXT,
        od TEXT,
        do TEXT,
        odcinek_kabla TEXT,
        geom BLOB
      );
    `);

    db.prepare('INSERT INTO PA VALUES (?, ?, ?, ?, ?, ?)').run(
      'pa-1',
      'Radom',
      'Polna',
      '15',
      '12/3',
      pointGeometry(574000, 424000),
    );
    db.prepare('INSERT INTO Lokale VALUES (?, ?, ?)').run('pa-1', 'RADOM/OSD0001', '1');
    db.prepare('INSERT INTO Rejonizacja VALUES (?, ?, ?, ?, ?)').run(
      'RADOM/OSD0001',
      4,
      1,
      'K-1',
      polygonGeometry([
        [573900, 423900],
        [574100, 423900],
        [574100, 424100],
        [573900, 423900],
      ]),
    );
    db.prepare('INSERT INTO "Kable Swiatlowodowe" VALUES (?, ?, ?, ?, ?, ?)').run(
      'MI-MKF 48J',
      'Kabel doziemny',
      'RADOM/ZS0001',
      'RADOM/OSD0001',
      'TK-1',
      lineGeometry([
        [574000, 424000],
        [574500, 424500],
      ]),
    );
    db.close();

    const result = extractGpkg(gpkgPath);

    expect(result.addresses[0]).toMatchObject({
      city: 'Radom',
      street: 'Polna',
      buildingNo: '15',
      distributionPoint: 'RADOM/OSD0001',
    });
    expect(result.addresses[0].lat).toBeGreaterThan(48);
    expect(result.addresses[0].lng).toBeGreaterThan(13);
    expect(result.polygons[0]).toMatchObject({
      osdName: 'RADOM/OSD0001',
      label: 'RADOM/OSD0001',
      households: 4,
      paCount: 1,
      cableRef: 'K-1',
    });
    expect(result.trunkCables[0]).toMatchObject({
      fromNode: 'RADOM/ZS0001',
      toNode: 'RADOM/OSD0001',
      osdName: 'RADOM/OSD0001',
      rawName: 'TK-1',
      routingType: 'underground',
    });
    expect(result.infraNodes.map((node) => node.nodeType).sort()).toEqual(['OSD', 'ZS']);
  });

  it('keeps split ADSS cable segments under one raw cable name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-gpkg-adss-map-'));
    const gpkgPath = join(dir, 'sample.gpkg');
    const db = new Database(gpkgPath);

    db.exec(`
      CREATE TABLE PA (
        id_posesja_opl TEXT,
        nazwa_miejsc TEXT,
        nazwa_ul TEXT,
        nr_domu TEXT,
        nr_dzialki TEXT,
        geom BLOB
      );
      CREATE TABLE "Kable Swiatlowodowe" (
        model_kabla TEXT,
        typ_elementu TEXT,
        od TEXT,
        do TEXT,
        odcinek_kabla TEXT,
        geom BLOB
      );
    `);

    db.prepare('INSERT INTO PA VALUES (?, ?, ?, ?, ?, ?)').run(
      'pa-1',
      'Olsztyn',
      'Testowa',
      '1',
      null,
      pointGeometry(574000, 424000),
    );
    db.prepare('INSERT INTO "Kable Swiatlowodowe" VALUES (?, ?, ?, ?, ?, ?)').run(
      'ADSS LTC 12J G.652D',
      'Kabel napowietrzny',
      'OLSZTYN/ZS00003',
      'OLSZTYN/OPP0004',
      'OKH0030737-BC/009',
      lineGeometry([
        [574000, 424000],
        [574100, 424100],
      ]),
    );
    db.prepare('INSERT INTO "Kable Swiatlowodowe" VALUES (?, ?, ?, ?, ?, ?)').run(
      'ADSS LTC 12J G.652D',
      'Kabel napowietrzny',
      'OLSZTYN/ZS00003',
      'OLSZTYN/OPP0004',
      'OKH0030737-BC/009',
      lineGeometry([
        [574100, 424100],
        [574250, 424250],
      ]),
    );
    db.close();

    const result = extractGpkg(gpkgPath);

    expect(result.trunkCables).toHaveLength(1);
    expect(result.trunkCables[0]).toMatchObject({
      cableType: 'ADSS LTC 12J G.652D',
      fromNode: 'OLSZTYN/ZS00003',
      toNode: 'OLSZTYN/OPP0004',
      rawName: 'OKH0030737-BC/009',
      routingType: 'aerial',
    });
    expect(result.trunkCables[0].geojson).toMatchObject({
      type: 'MultiLineString',
      coordinates: expect.arrayContaining([expect.any(Array), expect.any(Array)]),
    });
  });

  it('marks cables in existing ducts as a distinct map route type', () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-gpkg-existing-duct-map-'));
    const gpkgPath = join(dir, 'sample.gpkg');
    const db = new Database(gpkgPath);

    db.exec(`
      CREATE TABLE PA (
        id_posesja_opl TEXT,
        nazwa_miejsc TEXT,
        nazwa_ul TEXT,
        nr_domu TEXT,
        nr_dzialki TEXT,
        geom BLOB
      );
      CREATE TABLE "Kable Swiatlowodowe" (
        model_kabla TEXT,
        typ_elementu TEXT,
        od TEXT,
        do TEXT,
        odcinek_kabla TEXT,
        geom BLOB
      );
    `);

    db.prepare('INSERT INTO PA VALUES (?, ?, ?, ?, ?, ?)').run(
      'pa-1',
      'Radom',
      'Testowa',
      '1',
      null,
      pointGeometry(574000, 424000),
    );
    db.prepare('INSERT INTO "Kable Swiatlowodowe" VALUES (?, ?, ?, ?, ?, ?)').run(
      'MI-MKF 12J G.652D',
      'Kabel w kanalizacji',
      'RADOM/ZS00001',
      'RADOM/OPP0001',
      'OKH-ISTN-KAN/001',
      lineGeometry([
        [574000, 424000],
        [574100, 424100],
      ]),
    );
    db.close();

    const result = extractGpkg(gpkgPath);

    expect(result.trunkCables[0]).toMatchObject({
      rawName: 'OKH-ISTN-KAN/001',
      routingType: 'existing_duct',
    });
  });

  it('keeps cables in newly built conduit as underground route work', () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-gpkg-new-conduit-map-'));
    const gpkgPath = join(dir, 'sample.gpkg');
    const db = new Database(gpkgPath);

    db.exec(`
      CREATE TABLE PA (
        id_posesja_opl TEXT,
        nazwa_miejsc TEXT,
        nazwa_ul TEXT,
        nr_domu TEXT,
        nr_dzialki TEXT,
        geom BLOB
      );
      CREATE TABLE "Kable Swiatlowodowe" (
        model_kabla TEXT,
        typ_elementu TEXT,
        od TEXT,
        do TEXT,
        odcinek_kabla TEXT,
        geom BLOB
      );
    `);

    db.prepare('INSERT INTO PA VALUES (?, ?, ?, ?, ?, ?)').run(
      'pa-1',
      'Ostrzeszewo',
      'Testowa',
      '1',
      null,
      pointGeometry(574000, 424000),
    );
    const insertCable = db.prepare('INSERT INTO "Kable Swiatlowodowe" VALUES (?, ?, ?, ?, ?, ?)');
    insertCable.run(
      'MI-MKF 12J G.652D',
      'Kabel w nowobudowanym rurociagu',
      'OSTRZESZEWO/OPP0002',
      'OSTRZESZEWO/OSD0001',
      'OKW0337263/001',
      lineGeometry([
        [574000, 424000],
        [574100, 424100],
      ]),
    );
    insertCable.run(
      'MI-MKF 12J G.652D',
      'Projektowany kabel w rurociagu',
      'OSTRZESZEWO/OPP0002',
      'OSTRZESZEWO/OSD0002',
      'OKW0337271/001',
      lineGeometry([
        [574100, 424100],
        [574200, 424200],
      ]),
    );
    db.close();

    const result = extractGpkg(gpkgPath);

    expect(result.trunkCables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rawName: 'OKW0337263/001', routingType: 'underground' }),
        expect.objectContaining({ rawName: 'OKW0337271/001', routingType: 'underground' }),
      ]),
    );
  });

  it('uses projected conduit geometry to keep duct-described cables as underground work', () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-gpkg-projected-conduit-map-'));
    const gpkgPath = join(dir, 'sample.gpkg');
    const db = new Database(gpkgPath);

    db.exec(`
      CREATE TABLE PA (
        id_posesja_opl TEXT,
        nazwa_miejsc TEXT,
        nazwa_ul TEXT,
        nr_domu TEXT,
        nr_dzialki TEXT,
        geom BLOB
      );
      CREATE TABLE "Kable Swiatlowodowe" (
        model_kabla TEXT,
        typ_elementu TEXT,
        od TEXT,
        do TEXT,
        odcinek_kabla TEXT,
        geom BLOB
      );
      CREATE TABLE "Rurociagi_Mikrokanalizacja" (
        typ_elementu TEXT,
        odcinek TEXT,
        geom BLOB
      );
    `);

    const route = lineGeometry([
      [574000, 424000],
      [574100, 424100],
    ]);
    db.prepare('INSERT INTO PA VALUES (?, ?, ?, ?, ?, ?)').run(
      'pa-1',
      'Ostrzeszewo',
      'Testowa',
      '1',
      null,
      pointGeometry(574000, 424000),
    );
    db.prepare('INSERT INTO "Rurociagi_Mikrokanalizacja" VALUES (?, ?, ?)').run(
      'r',
      'OSTRZESZEWO/OPP0002-OSTRZESZEWO/OSD0001_RK/001',
      route,
    );
    db.prepare('INSERT INTO "Kable Swiatlowodowe" VALUES (?, ?, ?, ?, ?, ?)').run(
      'MI-MKF 12J G.652D',
      'Kabel w kanalizacji',
      'OSTRZESZEWO/OPP0002',
      'OSTRZESZEWO/OSD0001',
      'OKW0337263/001',
      route,
    );
    db.close();

    const result = extractGpkg(gpkgPath);

    expect(result.trunkCables[0]).toMatchObject({
      rawName: 'OKW0337263/001',
      routingType: 'underground',
    });
  });

  it('marks underground cable rows with existing duct modification as existing duct work', () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-gpkg-existing-duct-modification-'));
    const gpkgPath = join(dir, 'sample.gpkg');
    const db = new Database(gpkgPath);

    db.exec(`
      CREATE TABLE PA (
        id_posesja_opl TEXT,
        nazwa_miejsc TEXT,
        nazwa_ul TEXT,
        nr_domu TEXT,
        nr_dzialki TEXT,
        geom BLOB
      );
      CREATE TABLE "Kable Swiatlowodowe" (
        model_kabla TEXT,
        typ_elementu TEXT,
        modyfikacja TEXT,
        od TEXT,
        do TEXT,
        odcinek_kabla TEXT,
        geom BLOB
      );
    `);

    db.prepare('INSERT INTO PA VALUES (?, ?, ?, ?, ?, ?)').run(
      'pa-1',
      'Bartag',
      'Testowa',
      '1',
      null,
      pointGeometry(574000, 424000),
    );
    db.prepare('INSERT INTO "Kable Swiatlowodowe" VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'MI-MKF 12J G.652D',
      'Kabel doziemny',
      'Kabel prowadzony w istniejacej kanalizacji',
      'BARTAG/OPP0002',
      'BARTAG/OSD0026',
      'OKH0030735-DBA/026',
      lineGeometry([
        [574000, 424000],
        [574100, 424100],
      ]),
    );
    db.close();

    const result = extractGpkg(gpkgPath);

    expect(result.trunkCables[0]).toMatchObject({
      rawName: 'OKH0030735-DBA/026',
      routingType: 'existing_duct',
    });
  });

  it('marks underground cable rows as existing duct when they follow underscore duct infrastructure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-gpkg-existing-duct-geometry-'));
    const gpkgPath = join(dir, 'sample.gpkg');
    const db = new Database(gpkgPath);

    db.exec(`
      CREATE TABLE PA (
        id_posesja_opl TEXT,
        nazwa_miejsc TEXT,
        nazwa_ul TEXT,
        nr_domu TEXT,
        nr_dzialki TEXT,
        geom BLOB
      );
      CREATE TABLE "Kable Swiatlowodowe" (
        model_kabla TEXT,
        typ_elementu TEXT,
        od TEXT,
        do TEXT,
        odcinek_kabla TEXT,
        geom BLOB
      );
      CREATE TABLE "_Odcinki Kanalizacji" (
        typ_elementu TEXT,
        oznaczenie TEXT,
        geom BLOB
      );
    `);

    const ductRoute = lineGeometry([
      [574000, 424000],
      [574100, 424100],
    ]);
    const cableRoute = lineGeometry([
      [574000, 424000],
      [574100, 424100],
      [574200, 424100],
    ]);
    db.prepare('INSERT INTO PA VALUES (?, ?, ?, ?, ?, ?)').run(
      'pa-1',
      'Bartag',
      'Testowa',
      '1',
      null,
      pointGeometry(574000, 424000),
    );
    db.prepare('INSERT INTO "_Odcinki Kanalizacji" VALUES (?, ?, ?)').run(
      'Kanalizacja pierwotna',
      'BARTAG/KAN/026',
      ductRoute,
    );
    db.prepare('INSERT INTO "Kable Swiatlowodowe" VALUES (?, ?, ?, ?, ?, ?)').run(
      'MI-MKF 12J G.652D [ZN-05_[W1]_1x12(12)]',
      'Kabel doziemny',
      'BARTAG/OPP0002',
      'BARTAG/OSD0026',
      'OKH0030735-DBA/026',
      cableRoute,
    );
    db.close();

    const result = extractGpkg(gpkgPath);

    expect(result.trunkCables[0]).toMatchObject({
      rawName: 'OKH0030735-DBA/026',
      routingType: 'existing_duct',
    });
  });

  it('keeps OKW cable rows as underground even when they overlap existing duct infrastructure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-gpkg-okw-underground-over-duct-'));
    const gpkgPath = join(dir, 'sample.gpkg');
    const db = new Database(gpkgPath);

    db.exec(`
      CREATE TABLE PA (
        id_posesja_opl TEXT,
        nazwa_miejsc TEXT,
        nazwa_ul TEXT,
        nr_domu TEXT,
        nr_dzialki TEXT,
        geom BLOB
      );
      CREATE TABLE "Kable Swiatlowodowe" (
        model_kabla TEXT,
        typ_elementu TEXT,
        od TEXT,
        do TEXT,
        odcinek_kabla TEXT,
        geom BLOB
      );
      CREATE TABLE "_Odcinki Kanalizacji" (
        typ_elementu TEXT,
        oznaczenie TEXT,
        geom BLOB
      );
    `);

    const ductRoute = lineGeometry([
      [574000, 424000],
      [574100, 424100],
    ]);
    db.prepare('INSERT INTO PA VALUES (?, ?, ?, ?, ?, ?)').run(
      'pa-1',
      'Ostrzeszewo',
      'Testowa',
      '1',
      null,
      pointGeometry(574000, 424000),
    );
    db.prepare('INSERT INTO "_Odcinki Kanalizacji" VALUES (?, ?, ?)').run(
      'Kanalizacja pierwotna',
      'OSTRZESZEWO/KAN/001',
      ductRoute,
    );

    const insertCable = db.prepare('INSERT INTO "Kable Swiatlowodowe" VALUES (?, ?, ?, ?, ?, ?)');
    insertCable.run(
      'MI-MKF 12J G.652D [ZN-05_[W1]_1x12(12)]',
      'Kabel doziemny',
      'OSTRZESZEWO/OPP0002',
      'OSTRZESZEWO/OSD0001',
      'OKW0337263/001',
      ductRoute,
    );
    insertCable.run(
      'MI-MKF 12J G.652D [ZN-05_[W1]_1x12(12)]',
      'Kabel doziemny',
      'OSTRZESZEWO/OPP0002',
      'OSTRZESZEWO/OSD0002',
      'OKW0337271/001',
      ductRoute,
    );
    insertCable.run(
      'MI-MKF 72J G.652D [ZN-05_[W1]_6x12(72)]',
      'Kabel doziemny',
      'OSTRZESZEWO/OPP0002',
      'OSTRZESZEWO/OSD0003',
      'OKW0337264/001',
      ductRoute,
    );
    db.close();

    const result = extractGpkg(gpkgPath);

    expect(result.trunkCables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rawName: 'OKW0337263/001', routingType: 'underground' }),
        expect.objectContaining({ rawName: 'OKW0337271/001', routingType: 'underground' }),
        expect.objectContaining({ rawName: 'OKW0337264/001', routingType: 'underground' }),
      ]),
    );
  });

  it('extracts pole infrastructure from _Obiekty instead of conceptual pole layers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-gpkg-obiekty-poles-'));
    const gpkgPath = join(dir, 'sample.gpkg');
    const db = new Database(gpkgPath);

    db.exec(`
      CREATE TABLE PA (
        id_posesja_opl TEXT,
        nazwa_miejsc TEXT,
        nazwa_ul TEXT,
        nr_domu TEXT,
        nr_dzialki TEXT,
        geom BLOB
      );
      CREATE TABLE "K Slupy" (
        nazwa_slupa TEXT,
        wlasciciel TEXT,
        geom BLOB
      );
      CREATE TABLE "_Obiekty" (
        oznaczenie TEXT,
        typ_elementu TEXT,
        wlasciciel TEXT,
        geom BLOB
      );
    `);

    db.prepare('INSERT INTO PA VALUES (?, ?, ?, ?, ?, ?)').run(
      'pa-1',
      'Bartag',
      'Testowa',
      '1',
      null,
      pointGeometry(574000, 424000),
    );
    db.prepare('INSERT INTO "K Slupy" VALUES (?, ?, ?)').run(
      'KONCEPCYJNY/SLP0001',
      'ORANGE POLSKA S.A.',
      pointGeometry(574050, 424050),
    );
    db.prepare('INSERT INTO "_Obiekty" VALUES (?, ?, ?, ?)').run(
      'BARTAG/SLP0042',
      'Słup elektroenergetyczny',
      'ENERGA-OPERATOR S.A.',
      pointGeometry(574070, 424070),
    );
    db.close();

    const result = extractGpkg(gpkgPath);
    const poles = result.infrastructureFeatures.filter((feature) => feature.featureType === 'pole');

    expect(poles).toEqual([
      expect.objectContaining({
        sourceLayer: '_Obiekty',
        label: 'BARTAG/SLP0042',
        elementType: 'Słup elektroenergetyczny',
      }),
    ]);
  });

  it('extracts manhole infrastructure from _Obiekty rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-gpkg-obiekty-manholes-'));
    const gpkgPath = join(dir, 'sample.gpkg');
    const db = new Database(gpkgPath);

    db.exec(`
      CREATE TABLE PA (
        id_posesja_opl TEXT,
        nazwa_miejsc TEXT,
        nazwa_ul TEXT,
        nr_domu TEXT,
        nr_dzialki TEXT,
        geom BLOB
      );
      CREATE TABLE "_Obiekty" (
        oznaczenie TEXT,
        typ_elementu TEXT,
        wlasciciel TEXT,
        geom BLOB
      );
    `);

    db.prepare('INSERT INTO PA VALUES (?, ?, ?, ?, ?, ?)').run(
      'pa-1',
      'Bartag',
      'Testowa',
      '1',
      null,
      pointGeometry(574000, 424000),
    );
    db.prepare('INSERT INTO "_Obiekty" VALUES (?, ?, ?, ?)').run(
      'BARTAG/ST0026',
      'Studnia kablowa',
      'ORANGE POLSKA S.A.',
      pointGeometry(574070, 424070),
    );
    db.close();

    const result = extractGpkg(gpkgPath);
    const manholes = result.infrastructureFeatures.filter((feature) => feature.featureType === 'manhole');

    expect(manholes).toEqual([
      expect.objectContaining({
        sourceLayer: '_Obiekty',
        label: 'BARTAG/ST0026',
        elementType: 'Studnia kablowa',
      }),
    ]);
  });

  it('extracts duct, pole, and manhole infrastructure as background map features', () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-gpkg-background-infra-map-'));
    const gpkgPath = join(dir, 'sample.gpkg');
    const db = new Database(gpkgPath);

    db.exec(`
      CREATE TABLE PA (
        id_posesja_opl TEXT,
        nazwa_miejsc TEXT,
        nazwa_ul TEXT,
        nr_domu TEXT,
        nr_dzialki TEXT,
        geom BLOB
      );
      CREATE TABLE "_Odcinki Kanalizacji" (
        typ_elementu TEXT,
        oznaczenie TEXT,
        wlasciciel TEXT,
        geom BLOB
      );
      CREATE TABLE "_K Odcinki Kanalizacji" (
        typ_elementu TEXT,
        oznaczenie TEXT,
        wlasciciel TEXT,
        geom BLOB
      );
      CREATE TABLE "_Obiekty" (
        oznaczenie TEXT,
        typ_elementu TEXT,
        wlasciciel TEXT,
        geom BLOB
      );
    `);

    db.prepare('INSERT INTO PA VALUES (?, ?, ?, ?, ?, ?)').run(
      'pa-1',
      'Ostrzeszewo',
      'Testowa',
      '1',
      null,
      pointGeometry(574000, 424000),
    );
    db.prepare('INSERT INTO "_Odcinki Kanalizacji" VALUES (?, ?, ?, ?)').run(
      'Kanalizacja pierwotna',
      'OSTRZESZEWO/OK/001',
      'ORANGE POLSKA S.A.',
      lineGeometry([
        [574000, 424000],
        [574100, 424100],
      ]),
    );
    db.prepare('INSERT INTO "_K Odcinki Kanalizacji" VALUES (?, ?, ?, ?)').run(
      'Koncepcyjna kanalizacja',
      'OSTRZESZEWO/K/001',
      'ORANGE POLSKA S.A.',
      lineGeometry([
        [574200, 424200],
        [574300, 424300],
      ]),
    );
    db.prepare('INSERT INTO "_Obiekty" VALUES (?, ?, ?, ?)').run(
      'OSTRZESZEWO/SLP0001',
      'Słup elektroenergetyczny',
      'ORANGE POLSKA S.A.',
      pointGeometry(574050, 424050),
    );
    db.prepare('INSERT INTO "_Obiekty" VALUES (?, ?, ?, ?)').run(
      'OSTRZESZEWO/ST0001',
      'Studnia kablowa',
      'ORANGE POLSKA S.A.',
      pointGeometry(574070, 424070),
    );
    db.close();

    const result = extractGpkg(gpkgPath);

    expect(result.infrastructureFeatures).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceLayer: '_K Odcinki Kanalizacji',
        }),
      ]),
    );
    expect(result.infrastructureFeatures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          featureType: 'duct',
          sourceLayer: '_Odcinki Kanalizacji',
          label: 'OSTRZESZEWO/OK/001',
          elementType: 'Kanalizacja pierwotna',
          owner: 'ORANGE POLSKA S.A.',
          geojson: expect.objectContaining({ type: 'LineString' }),
        }),
        expect.objectContaining({
          featureType: 'pole',
          sourceLayer: '_Obiekty',
          label: 'OSTRZESZEWO/SLP0001',
          elementType: 'Słup elektroenergetyczny',
          owner: 'ORANGE POLSKA S.A.',
          geojson: expect.objectContaining({ type: 'Point' }),
        }),
        expect.objectContaining({
          featureType: 'manhole',
          sourceLayer: '_Obiekty',
          label: 'OSTRZESZEWO/ST0001',
          elementType: 'Studnia kablowa',
          owner: 'ORANGE POLSKA S.A.',
          geojson: expect.objectContaining({ type: 'Point' }),
        }),
      ]),
    );
  });

  it('extracts route and installation cable lengths for map popups', () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-gpkg-cable-lengths-'));
    const gpkgPath = join(dir, 'sample.gpkg');
    const db = new Database(gpkgPath);

    db.exec(`
      CREATE TABLE PA (
        id_posesja_opl TEXT,
        nazwa_miejsc TEXT,
        nazwa_ul TEXT,
        nr_domu TEXT,
        nr_dzialki TEXT,
        geom BLOB
      );
      CREATE TABLE "Kable Swiatlowodowe" (
        model_kabla TEXT,
        typ_elementu TEXT,
        od TEXT,
        do TEXT,
        odcinek_kabla TEXT,
        dlugosc_instalacyjna REAL,
        geom BLOB
      );
    `);

    db.prepare('INSERT INTO PA VALUES (?, ?, ?, ?, ?, ?)').run(
      'pa-1',
      'Radom',
      'Testowa',
      '1',
      null,
      pointGeometry(574000, 424000),
    );
    db.prepare('INSERT INTO "Kable Swiatlowodowe" VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'MI-MKF 12J G.652D',
      'Kabel doziemny',
      'RADOM/ZS00001',
      'RADOM/OPP0001',
      'OKH-LEN/001',
      620.5,
      lineGeometry([
        [574000, 424000],
        [574300, 424400],
      ]),
    );
    db.close();

    const result = extractGpkg(gpkgPath);

    expect(result.trunkCables[0]).toMatchObject({
      rawName: 'OKH-LEN/001',
      routeLengthMeters: 500,
      installationLengthMeters: 620.5,
    });
  });

  it('keeps map areas distinct when two localities use the same OPP number', () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-gpkg-duplicate-opp-map-'));
    const gpkgPath = join(dir, 'sample.gpkg');
    const db = new Database(gpkgPath);

    db.exec(`
      CREATE TABLE PA (
        id_posesja_opl TEXT,
        nazwa_miejsc TEXT,
        nazwa_ul TEXT,
        nr_domu TEXT,
        nr_dzialki TEXT,
        geom BLOB
      );
      CREATE TABLE Rejonizacja (
        rejonizacja TEXT,
        liczba_hh INTEGER,
        liczba_pa INTEGER,
        nr_kabla TEXT,
        geom BLOB
      );
      CREATE TABLE "Kable Swiatlowodowe" (
        model_kabla TEXT,
        typ_elementu TEXT,
        od TEXT,
        do TEXT,
        odcinek_kabla TEXT,
        geom BLOB
      );
    `);

    db.prepare('INSERT INTO PA VALUES (?, ?, ?, ?, ?, ?)').run(
      'pa-1',
      'Ostrzeszewo',
      'Ostrzeszewo',
      '10B',
      null,
      pointGeometry(574000, 424000),
    );
    db.prepare('INSERT INTO Rejonizacja VALUES (?, ?, ?, ?, ?)').run(
      'OSTRZESZEWO/OPP0002',
      4,
      4,
      'OKH0030737-BD/010',
      polygonGeometry([
        [574000, 424000],
        [574100, 424000],
        [574100, 424100],
        [574000, 424000],
      ]),
    );
    db.prepare('INSERT INTO Rejonizacja VALUES (?, ?, ?, ?, ?)').run(
      'KLEBARK MALY/OPP0002',
      1,
      1,
      'OKH0030737-BA/007',
      polygonGeometry([
        [575000, 425000],
        [575100, 425000],
        [575100, 425100],
        [575000, 425000],
      ]),
    );
    db.prepare('INSERT INTO "Kable Swiatlowodowe" VALUES (?, ?, ?, ?, ?, ?)').run(
      'MI-MKF 12J G.655D',
      'Kabel doziemny',
      'OSTRZESZEWO/ZS00002',
      'OSTRZESZEWO/OPP0002',
      'OKH0030737-BD/010',
      lineGeometry([
        [574000, 424000],
        [574100, 424100],
      ]),
    );
    db.prepare('INSERT INTO "Kable Swiatlowodowe" VALUES (?, ?, ?, ?, ?, ?)').run(
      'ADSS LTC 12J G.652D',
      'Kabel napowietrzny',
      'KLEBARK MALY/ZS00002',
      'KLEBARK MALY/OPP0002',
      'OKH0030737-BA/007',
      lineGeometry([
        [575000, 425000],
        [575100, 425100],
      ]),
    );
    db.close();

    const result = extractGpkg(gpkgPath);

    expect(result.polygons.map((polygon) => polygon.osdName).sort()).toEqual([
      'KLEBARK MALY/OPP0002',
      'OSTRZESZEWO/OPP0002',
    ]);
    expect(result.infraNodes.map((node) => node.name).sort()).toEqual([
      'KLEBARK MALY/OPP0002',
      'KLEBARK MALY/ZS00002',
      'OSTRZESZEWO/OPP0002',
      'OSTRZESZEWO/ZS00002',
    ]);
  });

  it('extracts projected passive OSD nodes even when they have no address points', () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-gpkg-passive-osd-map-'));
    const gpkgPath = join(dir, 'sample.gpkg');
    const db = new Database(gpkgPath);

    db.exec(`
      CREATE TABLE PA (
        id_posesja_opl TEXT,
        nazwa_miejsc TEXT,
        nazwa_ul TEXT,
        nr_domu TEXT,
        nr_dzialki TEXT,
        geom BLOB
      );
      CREATE TABLE "Urzadzenia Pasywne" (
        typ_elementu TEXT,
        model_urzadzenia TEXT,
        wezel TEXT,
        oznaczenie TEXT,
        modyfikacja TEXT,
        geom BLOB
      );
    `);

    db.prepare('INSERT INTO PA VALUES (?, ?, ?, ?, ?, ?)').run(
      'pa-1',
      'Radom',
      'Testowa',
      '1',
      null,
      pointGeometry(574000, 424000),
    );
    db.prepare('INSERT INTO "Urzadzenia Pasywne" VALUES (?, ?, ?, ?, ?, ?)').run(
      'Przełącznica światłowodowa',
      'PSP',
      'RADOM/OSD9999',
      'O_RADOM/OSD9999',
      null,
      pointGeometry(574250, 424250),
    );
    db.prepare('INSERT INTO "Urzadzenia Pasywne" VALUES (?, ?, ?, ?, ?, ?)').run(
      'Przełącznica światłowodowa',
      'PSP',
      'RADOM/OSD0001',
      'O_RADOM/OSD0001',
      'Istniejący',
      pointGeometry(574300, 424300),
    );
    db.close();

    const result = extractGpkg(gpkgPath);

    expect(result.infraNodes).toEqual([
      expect.objectContaining({
        nodeType: 'OSD',
        name: 'RADOM/OSD9999',
        label: 'O_RADOM/OSD9999',
        lat: expect.any(Number),
        lng: expect.any(Number),
      }),
    ]);
  });

  it('keeps only existing passive nodes that participate in projected splices', () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-gpkg-existing-passive-splices-'));
    const gpkgPath = join(dir, 'sample.gpkg');
    const db = new Database(gpkgPath);

    db.exec(`
      CREATE TABLE PA (
        id_posesja_opl TEXT,
        nazwa_miejsc TEXT,
        nazwa_ul TEXT,
        nr_domu TEXT,
        nr_dzialki TEXT,
        geom BLOB
      );
      CREATE TABLE "_Urzadzenia Pasywne" (
        typ_elementu TEXT,
        model_urzadzenia TEXT,
        wezel TEXT,
        oznaczenie TEXT,
        modyfikacja TEXT,
        geom BLOB
      );
      CREATE TABLE Wlokna (
        wezel_pocz TEXT,
        oznaczenie_urzadzenia_pocz TEXT,
        typ_polaczenia_pocz TEXT,
        pigtail_pocz_spaw TEXT,
        wezel_kon TEXT,
        oznaczenie_urzadzenia_kon TEXT,
        typ_polaczenia_kon TEXT,
        pigtail_kon_spaw TEXT
      );
    `);

    db.prepare('INSERT INTO PA VALUES (?, ?, ?, ?, ?, ?)').run(
      'pa-1',
      'Radom',
      'Testowa',
      '1',
      null,
      pointGeometry(574000, 424000),
    );
    const insertPassive = db.prepare('INSERT INTO "_Urzadzenia Pasywne" VALUES (?, ?, ?, ?, ?, ?)');
    insertPassive.run('Przelacznica', 'PSP', 'RADOM/OPP0001', 'O_RADOM/OPP0001', null, pointGeometry(574100, 424100));
    insertPassive.run('Przelacznica', 'PSP', 'RADOM/OSD0001', 'O_RADOM/OSD0001', null, pointGeometry(574110, 424110));
    insertPassive.run('Mufa', 'FIST', 'RADOM/ZS0001', 'O_RADOM/ZS0001', null, pointGeometry(574120, 424120));
    insertPassive.run('Przelacznica', 'PSP', 'RADOM/OPP0002', 'O_RADOM/OPP0002', 'Istniejacy', pointGeometry(574200, 424200));
    insertPassive.run('Przelacznica', 'PSP', 'RADOM/OSD0002', 'O_RADOM/OSD0002', 'Istniejacy', pointGeometry(574210, 424210));
    insertPassive.run('Mufa', 'FIST', 'RADOM/ZS0002', 'O_RADOM/ZS0002', 'Istniejacy', pointGeometry(574220, 424220));

    const insertFiber = db.prepare('INSERT INTO Wlokna VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    insertFiber.run(
      'RADOM/ZS0002',
      'O_RADOM/ZS0002',
      'Spaw termiczny projektowany',
      '',
      'RADOM/OPP0002',
      'O_RADOM/OPP0002',
      'Zlaczka projektowana',
      'Spaw termiczny projektowany',
    );
    insertFiber.run(
      'RADOM/OSD0002',
      'O_RADOM/OSD0002',
      'Spaw termiczny projektowany',
      '',
      'RADOM/OPP0002',
      'O_RADOM/OPP0002',
      'Zlaczka projektowana',
      '',
    );
    db.close();

    const result = extractGpkg(gpkgPath);

    expect(result.infraNodes.map((node) => node.name).sort()).toEqual([
      'RADOM/OPP0002',
      'RADOM/OSD0002',
      'RADOM/ZS0002',
    ]);
    expect(result.passiveInfraNodes.map((node) => node.name).sort()).toEqual([
      'RADOM/OPP0002',
      'RADOM/OSD0002',
      'RADOM/ZS0002',
    ]);
    expect(result.splices).toEqual([{ wezel: 'RADOM/ZS0002', oznaczenie: 'O_RADOM/ZS0002' }]);
  });
});
