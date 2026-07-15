import type { MapNoteTargetType, ProjectMapNote, ProjectRecord } from '../types.js';
import {
  buildXlsxWorkbook,
  type XlsxCell,
  type XlsxSheet,
  type XlsxStyle,
} from './xlsx-writer.js';

export interface MapNotesSummary {
  overview: string;
  blockers: string[];
  recommendedActions: string[];
  attentionPoints: string[];
  model: string;
  generatedAt: string;
}

const NOTE_TYPE_LABELS: Record<MapNoteTargetType, string> = {
  cable: 'Kabel',
  node: 'Punkt',
  address: 'Adres',
  polygon: 'Obszar',
  free: 'Miejsce na mapie',
};

function textCell(value: string | number | null, style: XlsxStyle = 'default'): XlsxCell {
  return { value, style };
}

function headerRow(labels: string[]): XlsxCell[] {
  return labels.map((label) => textCell(label, 'header'));
}

function buildNoteRows(notes: ProjectMapNote[]): XlsxCell[][] {
  const rows: XlsxCell[][] = [
    headerRow([
      'Lp',
      'Typ',
      'Obiekt',
      'Tresc',
      'Lat',
      'Lng',
      'Zdjecia',
      'Utworzono',
      'Aktualizacja',
    ]),
  ];

  if (notes.length === 0) {
    rows.push([textCell('Brak notatek nieprzypisanych do adresow', 'muted')]);
    return rows;
  }

  notes.forEach((note, index) => {
    rows.push([
      textCell(index + 1),
      textCell(NOTE_TYPE_LABELS[note.targetType]),
      textCell(note.targetLabel ?? note.targetId ?? ''),
      textCell(note.body),
      textCell(note.lat),
      textCell(note.lng),
      textCell(note.photoCount),
      textCell(note.createdAt),
      textCell(note.updatedAt),
    ]);
  });

  return rows;
}

function buildSummaryList(title: string, items: string[]): XlsxCell[][] {
  return [
    [textCell(title, 'header')],
    ...(items.length > 0
      ? items.map((item, index) => [textCell(index + 1), textCell(item)])
      : [[textCell('Brak')]]),
  ];
}

function buildSummarySheet(project: ProjectRecord, summary: MapNotesSummary): XlsxSheet {
  return {
    name: 'Podsumowanie Qwen',
    rows: [
      [textCell(`Podsumowanie Qwen: ${project.name}`, 'header')],
      [textCell('Model', 'header'), textCell(summary.model)],
      [textCell('Wygenerowano', 'header'), textCell(summary.generatedAt)],
      [],
      [textCell('Podsumowanie', 'header')],
      [textCell(summary.overview)],
      [],
      ...buildSummaryList('Blokery', summary.blockers),
      [],
      ...buildSummaryList('Rekomendowane dzialania', summary.recommendedActions),
      [],
      ...buildSummaryList('Punkty wymagajace uwagi', summary.attentionPoints),
    ],
  };
}

export function getExportableMapNotes(notes: ProjectMapNote[]): ProjectMapNote[] {
  return notes.filter((note) => note.targetType !== 'address');
}

export function buildMapNotesReport(
  project: ProjectRecord,
  notes: ProjectMapNote[],
  summary?: MapNotesSummary,
): Buffer {
  const exportableNotes = getExportableMapNotes(notes);
  const sheets: XlsxSheet[] = [
    {
      name: 'Notatki',
      rows: [
        [textCell(`Raport notatek z mapy: ${project.name}`, 'header')],
        [textCell(`Wygenerowano: ${new Date().toISOString()}`)],
        [textCell(`Liczba notatek: ${exportableNotes.length}`)],
        [],
        ...buildNoteRows(exportableNotes),
      ],
    },
  ];

  if (summary) sheets.push(buildSummarySheet(project, summary));

  return buildXlsxWorkbook(sheets);
}
