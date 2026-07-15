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

function workbookContent(workbook: Buffer): string {
  return workbook.toString('utf8');
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
    const content = workbookContent(workbook);

    expect(workbook.subarray(0, 2).toString('ascii')).toBe('PK');
    expect(content).toContain('Notatki');
    expect(content).toContain('Raport notatek z mapy: Projekt testowy');
    expect(content).toContain('Wygenerowano:');
    expect(content).toContain('Liczba notatek: 4');
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
      expect(content).toContain(column);
    }
    for (const label of ['Kabel', 'Punkt', 'Obszar', 'Miejsce na mapie']) {
      expect(content).toContain(label);
    }
    for (const body of [
      'Niedroznosc kabla',
      'Pokrywa punktu do wymiany',
      'Kolizja w obszarze',
      'Uszkodzona nawierzchnia',
    ]) {
      expect(content).toContain(body);
    }
    expect(content).toContain('Kabel K-1');
    expect(content).toContain('node-1');
    expect(content).toContain('53.72');
    expect(content).toContain('20.52');
    expect(content).not.toContain('Komentarz adresowy - nie eksportowac');
  });

  it('builds a valid empty workbook with headers and an explicit empty row', () => {
    const workbook = buildMapNotesReport(project, [
      createNote({ id: 'address-note', targetType: 'address', body: 'Tylko adres' }),
    ]);
    const content = workbookContent(workbook);

    expect(workbook.subarray(0, 2).toString('ascii')).toBe('PK');
    expect(content).toContain('Notatki');
    expect(content).toContain('Liczba notatek: 0');
    expect(content).toContain('Lp');
    expect(content).toContain('Aktualizacja');
    expect(content).toContain('Brak notatek nieprzypisanych do adresow');
    expect(content).not.toContain('Tylko adres');
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

    const content = workbookContent(
      buildMapNotesReport(
        project,
        [createNote({ id: 'free-note', targetType: 'free', body: 'Notatka terenowa' })],
        summary,
      ),
    );

    expect(content).toContain('Podsumowanie Qwen');
    expect(content).toContain(summary.overview);
    for (const value of [
      ...summary.blockers,
      ...summary.recommendedActions,
      ...summary.attentionPoints,
      summary.model,
      summary.generatedAt,
    ]) {
      expect(content).toContain(value);
    }
  });
});
