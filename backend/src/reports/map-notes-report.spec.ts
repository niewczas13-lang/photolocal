import { describe, expect, it } from 'vitest';
import type { ProjectMapNote, ProjectRecord } from '../types.js';
import {
  buildMapNotesReport,
  getExportableMapNotes,
  type MapNotesSummary,
} from './map-notes-report.js';

const project: ProjectRecord = {
  id: 'project-1',
  name: 'Projekt testowy',
  projectDefinition: null,
  projectType: 'SI',
  splitterTopology: 'SINGLE',
  splitterCount: 1,
  splitterTopologySource: 'AUTO',
  gpkgFileName: 'projekt.gpkg',
  baseFolder: 'C:/photos/PROJEKT_TESTOWY',
  googleChatSpaceName: null,
  googleChatSpaceDisplayName: null,
  googleChatLastDownloadAt: null,
  addressCount: 0,
  dacToAddressCableCount: 0,
  adssToAddressCableCount: 0,
  progressDone: 0,
  progressTotal: 0,
  status: 'W trakcie',
  createdAt: '2026-07-15T08:00:00.000Z',
  updatedAt: '2026-07-15T09:00:00.000Z',
};

const NOTES_ONLY_SHEETS_XML = [
  '<sheets>',
  '<sheet name="Notatki" sheetId="1" r:id="rId1"/>',
  '</sheets>',
].join('');

const NOTES_AND_SUMMARY_SHEETS_XML = [
  '<sheets>',
  '<sheet name="Notatki" sheetId="1" r:id="rId1"/>',
  '<sheet name="Podsumowanie Qwen" sheetId="2" r:id="rId2"/>',
  '</sheets>',
].join('');

type CreateNoteInput = Pick<ProjectMapNote, 'id' | 'targetType' | 'body'> &
  Partial<Omit<ProjectMapNote, 'id' | 'targetType' | 'body'>>;

function createNote({ id, targetType, body, ...overrides }: CreateNoteInput): ProjectMapNote {
  return {
    id,
    targetType,
    targetId: null,
    targetLabel: null,
    body,
    lat: null,
    lng: null,
    photoCount: 0,
    photos: [],
    createdAt: '2026-07-15T10:00:00.000Z',
    updatedAt: '2026-07-15T11:00:00.000Z',
    ...overrides,
  };
}

function readStoreOnlyZipEntries(archive: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  const localHeaderSignature = 0x04034b50;
  const localHeaderSize = 30;
  let offset = 0;

  while (
    offset + localHeaderSize <= archive.length &&
    archive.readUInt32LE(offset) === localHeaderSignature
  ) {
    const compressionMethod = archive.readUInt16LE(offset + 8);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const uncompressedSize = archive.readUInt32LE(offset + 22);
    const fileNameLength = archive.readUInt16LE(offset + 26);
    const extraFieldLength = archive.readUInt16LE(offset + 28);
    const fileNameStart = offset + localHeaderSize;
    const fileNameEnd = fileNameStart + fileNameLength;
    const dataStart = fileNameEnd + extraFieldLength;
    const dataEnd = dataStart + compressedSize;

    if (compressionMethod !== 0 || compressedSize !== uncompressedSize) {
      throw new Error('Expected a store-only ZIP entry');
    }
    if (dataEnd > archive.length) throw new Error('Invalid ZIP entry length');

    const name = archive.subarray(fileNameStart, fileNameEnd).toString('utf8');
    if (entries.has(name)) throw new Error(`Duplicate ZIP entry: ${name}`);
    entries.set(name, archive.subarray(dataStart, dataEnd));
    offset = dataEnd;
  }

  if (entries.size === 0) throw new Error('No local ZIP entries found');
  return entries;
}

function readZipTextEntry(entries: Map<string, Buffer>, name: string): string {
  const entry = entries.get(name);
  if (!entry) throw new Error(`Missing ZIP entry: ${name}`);
  return entry.toString('utf8');
}

function zipEntryNamesContainingText(entries: Map<string, Buffer>, text: string): string[] {
  return [...entries.entries()]
    .filter(([, entry]) => entry.toString('utf8').includes(text))
    .map(([name]) => name);
}

function workbookSheetsXml(workbookXml: string): string {
  const match = workbookXml.match(/<sheets>[\s\S]*?<\/sheets>/);
  if (!match) throw new Error('Workbook sheets list not found');
  return match[0];
}

function worksheetEntryNames(entries: Map<string, Buffer>): string[] {
  return [...entries.keys()].filter((name) => name.startsWith('xl/worksheets/'));
}

function worksheetSectionXml(worksheetXml: string, title: string, nextTitle?: string): string {
  const titleXml = `<t>${title}</t>`;
  const start = worksheetXml.indexOf(titleXml);
  if (start < 0) throw new Error(`Worksheet section not found: ${title}`);

  const end = nextTitle
    ? worksheetXml.indexOf(`<t>${nextTitle}</t>`, start + titleXml.length)
    : worksheetXml.length;
  if (end < 0) throw new Error(`Worksheet section not found: ${nextTitle}`);
  return worksheetXml.slice(start, end);
}

describe('map notes report', () => {
  it('excludes only address notes and preserves eligible notes in input order', () => {
    const notes = [
      createNote({ id: 'cable-note', targetType: 'cable', body: 'Kabel' }),
      createNote({ id: 'address-note', targetType: 'address', body: 'Adres' }),
      createNote({ id: 'node-note', targetType: 'node', body: 'Punkt' }),
      createNote({ id: 'polygon-note', targetType: 'polygon', body: 'Obszar' }),
      createNote({ id: 'free-note', targetType: 'free', body: 'Miejsce' }),
    ];

    expect(getExportableMapNotes(notes).map((note) => note.id)).toEqual([
      'cable-note',
      'node-note',
      'polygon-note',
      'free-note',
    ]);
  });

  it('builds a workbook with eligible note data, Polish labels, and approved columns', () => {
    const notes = [
      createNote({
        id: 'address-note',
        targetType: 'address',
        targetLabel: 'Lesna 1',
        body: 'Komentarz adresowy - nie eksportowac',
      }),
      createNote({
        id: 'cable-note',
        targetType: 'cable',
        targetLabel: 'Kabel K-1',
        body: 'Niedroznosc kabla',
        lat: 53.72,
        lng: 20.52,
        photoCount: 2,
      }),
      createNote({
        id: 'node-note',
        targetType: 'node',
        targetId: 'node-1',
        body: 'Pokrywa punktu do wymiany',
      }),
      createNote({ id: 'polygon-note', targetType: 'polygon', body: 'Kolizja w obszarze' }),
      createNote({ id: 'free-note', targetType: 'free', body: 'Uszkodzona nawierzchnia' }),
    ];

    const workbook = buildMapNotesReport(project, notes);
    const entries = readStoreOnlyZipEntries(workbook);
    const workbookXml = readZipTextEntry(entries, 'xl/workbook.xml');
    const notesXml = readZipTextEntry(entries, 'xl/worksheets/sheet1.xml');
    const generatedAt = notesXml.match(/Wygenerowano: ([^<]+)/)?.[1] ?? '';

    expect(workbook.subarray(0, 2).toString('ascii')).toBe('PK');
    expect(workbookSheetsXml(workbookXml)).toBe(NOTES_ONLY_SHEETS_XML);
    expect(worksheetEntryNames(entries)).toEqual(['xl/worksheets/sheet1.xml']);
    expect(entries.has('xl/worksheets/sheet2.xml')).toBe(false);
    expect(workbookXml).not.toContain('Podsumowanie Qwen');
    expect(notesXml).toContain('Raport notatek z mapy: Projekt testowy');
    expect(generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(generatedAt).toISOString()).toBe(generatedAt);
    expect(notesXml).toContain('Liczba notatek: 4');
    for (const column of [
      'Lp',
      'Typ',
      'Obiekt',
      'Tresc',
      'Lat',
      'Lng',
      'Zdjecia',
      'Utworzono',
      'Aktualizacja',
    ]) {
      expect(notesXml).toContain(column);
    }
    for (const label of ['Kabel', 'Punkt', 'Obszar', 'Miejsce na mapie']) {
      expect(notesXml).toContain(label);
    }
    for (const body of [
      'Niedroznosc kabla',
      'Pokrywa punktu do wymiany',
      'Kolizja w obszarze',
      'Uszkodzona nawierzchnia',
    ]) {
      expect(zipEntryNamesContainingText(entries, body)).toEqual([
        'xl/worksheets/sheet1.xml',
      ]);
    }
    expect(notesXml).toContain('Kabel K-1');
    expect(notesXml).toContain('node-1');
    expect(notesXml).toContain('53.72');
    expect(notesXml).toContain('20.52');
    expect(zipEntryNamesContainingText(entries, 'Komentarz adresowy - nie eksportowac')).toEqual(
      [],
    );
  });

  it('builds a valid empty workbook with headers and an explicit empty row', () => {
    const workbook = buildMapNotesReport(project, [
      createNote({ id: 'address-note', targetType: 'address', body: 'Tylko adres' }),
    ]);
    const entries = readStoreOnlyZipEntries(workbook);
    const workbookXml = readZipTextEntry(entries, 'xl/workbook.xml');
    const notesXml = readZipTextEntry(entries, 'xl/worksheets/sheet1.xml');

    expect(workbook.subarray(0, 2).toString('ascii')).toBe('PK');
    expect(workbookSheetsXml(workbookXml)).toBe(NOTES_ONLY_SHEETS_XML);
    expect(worksheetEntryNames(entries)).toEqual(['xl/worksheets/sheet1.xml']);
    expect(entries.has('xl/worksheets/sheet2.xml')).toBe(false);
    expect(workbookXml).not.toContain('Podsumowanie Qwen');
    expect(notesXml).toContain('Liczba notatek: 0');
    expect(notesXml).toContain('Lp');
    expect(notesXml).toContain('Aktualizacja');
    expect(notesXml).toContain('Brak notatek nieprzypisanych do adresow');
    expect(notesXml).not.toContain('Tylko adres');
  });

  it('adds a Qwen summary sheet with all supplied summary metadata', () => {
    const summary: MapNotesSummary = {
      overview: 'Dwie kwestie wymagaja reakcji.',
      blockers: ['Niedroznosc kabla', 'Brak dostepu do studni'],
      recommendedActions: ['Sprawdzic studnie S-1', 'Zaplanowac naprawe'],
      attentionPoints: ['Kabel K-1', 'Studnia S-1'],
      model: 'qwen2.5vl:3b',
      generatedAt: '2026-07-15T12:34:56.000Z',
    };

    const workbook = buildMapNotesReport(
      project,
      [createNote({ id: 'free-note', targetType: 'free', body: 'Notatka terenowa' })],
      summary,
    );
    const entries = readStoreOnlyZipEntries(workbook);
    const workbookXml = readZipTextEntry(entries, 'xl/workbook.xml');
    const summaryXml = readZipTextEntry(entries, 'xl/worksheets/sheet2.xml');

    expect(workbookSheetsXml(workbookXml)).toBe(NOTES_AND_SUMMARY_SHEETS_XML);
    expect(worksheetEntryNames(entries)).toEqual([
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
    ]);
    expect(zipEntryNamesContainingText(entries, 'Notatka terenowa')).toEqual([
      'xl/worksheets/sheet1.xml',
    ]);
    for (const value of [
      summary.overview,
      ...summary.blockers,
      ...summary.recommendedActions,
      ...summary.attentionPoints,
      summary.model,
      summary.generatedAt,
    ]) {
      expect(summaryXml).toContain(value);
      expect(zipEntryNamesContainingText(entries, value)).toEqual([
        'xl/worksheets/sheet2.xml',
      ]);
    }
  });

  it('renders Brak in every empty Qwen list section', () => {
    const summary: MapNotesSummary = {
      overview: 'Brak pilnych problemow.',
      blockers: [],
      recommendedActions: [],
      attentionPoints: [],
      model: 'qwen2.5vl:3b',
      generatedAt: '2026-07-15T12:34:56.000Z',
    };
    const workbook = buildMapNotesReport(project, [], summary);
    const entries = readStoreOnlyZipEntries(workbook);
    const summaryXml = readZipTextEntry(entries, 'xl/worksheets/sheet2.xml');

    expect(worksheetSectionXml(summaryXml, 'Blokery', 'Rekomendowane dzialania')).toContain(
      '<t>Brak</t>',
    );
    expect(
      worksheetSectionXml(summaryXml, 'Rekomendowane dzialania', 'Punkty wymagajace uwagi'),
    ).toContain('<t>Brak</t>');
    expect(worksheetSectionXml(summaryXml, 'Punkty wymagajace uwagi')).toContain('<t>Brak</t>');
  });
});
