import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { extractGpkg, inferSplitterTopology, normalizeCableAddressEntry } from './gpkg-extractor.js';

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
});
