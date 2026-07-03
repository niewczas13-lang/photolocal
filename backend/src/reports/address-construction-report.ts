import type { ProjectMapAddress, ProjectMapRecord, ProjectRecord } from '../types.js';
import { buildXlsxWorkbook, type XlsxCell, type XlsxStyle } from './xlsx-writer.js';

function textCell(value: string | number | null, style: XlsxStyle = 'default'): XlsxCell {
  return { value, style };
}

function headerRow(labels: string[]): XlsxCell[] {
  return labels.map((label) => textCell(label, 'header'));
}

function reserveTypeLabel(address: ProjectMapAddress): string {
  if (address.isAerialReserve) return 'Napowietrzny';
  if (address.photos.some((photo) => photo.reserveLocation === 'W studni')) return 'W studni';
  return 'Doziemny';
}

function addressStatusLabel(address: ProjectMapAddress): string {
  if (address.status === 'COMPLETE') return 'wybudowany';
  if (address.status === 'NOT_APPLICABLE') return 'nie dotyczy';
  return 'do zrobienia';
}

function completionSourceLabel(address: ProjectMapAddress): string {
  if (address.status !== 'COMPLETE') return '';
  if (address.usesDistributionPhotoForCompletion && address.hasDistributionPhoto && address.reservePhotoCount === 0) {
    return 'zdjecie OSD/OPP';
  }
  return 'zdjecie zapasu';
}

function addressRowStyle(address: ProjectMapAddress): XlsxStyle {
  if (address.status === 'COMPLETE') return 'done';
  if (address.status === 'NOT_APPLICABLE') return 'muted';
  if (address.isManuallyAdded && !address.oplConsentConfirmed) return 'warning';
  return 'pending';
}

function buildPhotoSummary(address: ProjectMapAddress): string {
  const parts = [`zapasy: ${address.reservePhotoCount}`];
  if (address.hasDistributionPhoto) parts.push('OSD/OPP: tak');
  return parts.join(', ');
}

function buildAddressNotes(map: ProjectMapRecord, address: ProjectMapAddress): string {
  return map.notes
    .filter(
      (note) =>
        note.targetType === 'address' &&
        (note.targetId === address.id || (!note.targetId && note.targetLabel === address.label)),
    )
    .map((note) => note.body.trim())
    .filter(Boolean)
    .join('\n');
}

function buildAddressRows(map: ProjectMapRecord): XlsxCell[][] {
  const rows: XlsxCell[][] = [
    headerRow([
      'Lp',
      'Miejscowosc',
      'Ulica',
      'Nr',
      'Adres',
      'Punkt OSD/OPP',
      'Typ zapasu',
      'Status',
      'Zdjecia',
      'Zrodlo zakonczenia',
      'Zgoda OPL',
      'Komentarze',
    ]),
  ];

  map.addresses.forEach((address, index) => {
    const style = addressRowStyle(address);
    rows.push(
      [
        index + 1,
        address.city,
        address.street,
        address.buildingNo ?? '',
        address.label,
        address.distributionPoint ?? '',
        reserveTypeLabel(address),
        addressStatusLabel(address),
        buildPhotoSummary(address),
        completionSourceLabel(address),
        address.isManuallyAdded ? (address.oplConsentConfirmed ? 'tak' : 'brak zgody') : '',
        buildAddressNotes(map, address),
      ].map((value) => textCell(value, style)),
    );
  });

  return rows;
}

function buildMapNoteRows(map: ProjectMapRecord): XlsxCell[][] {
  const rows: XlsxCell[][] = [
    headerRow(['Typ', 'Obiekt', 'Tresc', 'Lat', 'Lng', 'Zdjecia', 'Utworzono', 'Aktualizacja']),
  ];

  for (const note of map.notes) {
    rows.push([
      textCell(note.targetType),
      textCell(note.targetLabel ?? note.targetId ?? ''),
      textCell(note.body),
      textCell(note.lat),
      textCell(note.lng),
      textCell(note.photoCount),
      textCell(note.createdAt),
      textCell(note.updatedAt),
    ]);
  }

  return rows;
}

export function buildAddressConstructionReport(project: ProjectRecord, map: ProjectMapRecord): Buffer {
  return buildXlsxWorkbook([
    {
      name: 'Adresy',
      rows: [
        [textCell(`Raport budowy punktow adresowych: ${project.name}`, 'header')],
        [textCell(`Wygenerowano: ${new Date().toISOString()}`)],
        [],
        ...buildAddressRows(map),
      ],
    },
    {
      name: 'Notatki z mapy',
      rows: buildMapNoteRows(map),
    },
  ]);
}
