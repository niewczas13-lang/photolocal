import Database from 'better-sqlite3';
import fs from 'node:fs';
import type { AddressInput, GpkgExtractionResult, MufaEntry, SplitterTopology } from '../types.js';

function q(tableName: string): string {
  return `"${tableName.replace(/"/g, '""')}"`;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name: string } | undefined;
  return Boolean(row);
}

export function inferSplitterTopology(splitterCount: number): SplitterTopology {
  return splitterCount > 2 ? 'CASCADE' : 'SINGLE';
}

export function normalizeCableAddressEntry(value: string): string | null {
  const parts = value
    .replace(/\s+/g, ' ')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) return null;

  // If 3 or more parts (City, Street, Number), remove City.
  // If 2 parts (Street/Village, Number), keep both.
  const addressParts = parts.length >= 3 ? parts.slice(1) : parts;
  const cleaned = addressParts
    .join(' ')
    .replace(/^UL\.\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();

  return cleaned || null;
}

function countSplitters(db: Database.Database): number {
  const splitterTables = ['Urzadzenia Pasywne', 'Urządzenia Pasywne', '_Urzadzenia Pasywne', '_Urządzenia Pasywne', 'Plan_Urzadzenia Pasywne', 'Plan_Urządzenia Pasywne'];

  for (const tableName of splitterTables) {
    if (!tableExists(db, tableName)) continue;
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count FROM ${q(tableName)}
         WHERE lower(coalesce(typ_elementu, '')) LIKE '%spliter%'
            OR upper(coalesce(model_urzadzenia, '')) LIKE 'SPL%'`,
      )
      .get() as { count: number };
    if (row.count > 0) return row.count;
  }

  let sum = 0;
  for (const tableName of ['K OPP', 'K OSD']) {
    if (!tableExists(db, tableName)) continue;
    const row = db
      .prepare(`SELECT coalesce(sum(coalesce(liczba_spliterow, 0)), 0) AS count FROM ${q(tableName)}`)
      .get() as { count: number };
    sum += Number(row.count ?? 0);
  }
  return sum;
}

function extractAddresses(db: Database.Database): {
  addresses: AddressInput[];
  totalPaRows: number;
  totalLokaleRows: number;
  skippedNoGeom: number;
  skippedBadGeom: number;
} {
  if (!tableExists(db, 'PA')) {
    throw new Error('Brak wymaganej warstwy PA w pliku GPKG.');
  }

  const osdByProperty = new Map<string, string>();
  let totalLokaleRows = 0;
  if (tableExists(db, 'Lokale')) {
    const rows = db.prepare(`SELECT id_posesja_opl, opp_osd FROM ${q('Lokale')}`).all() as Array<{
      id_posesja_opl: unknown;
      opp_osd: unknown;
    }>;
    totalLokaleRows = rows.length;
    for (const row of rows) {
      const key = row.id_posesja_opl == null ? '' : String(row.id_posesja_opl).trim();
      const val = row.opp_osd == null ? '' : String(row.opp_osd).trim();
      if (key && val) osdByProperty.set(key, val);
    }
  }

  const paRows = db.prepare(`SELECT * FROM ${q('PA')}`).all() as Array<Record<string, unknown>>;
  const addresses: AddressInput[] = [];

  for (const row of paRows) {
    const propertyId = row.id_posesja_opl == null ? '' : String(row.id_posesja_opl).trim();
    addresses.push({
      city: row.nazwa_miejsc == null ? '' : String(row.nazwa_miejsc).trim(),
      street: row.nazwa_ul == null ? '' : String(row.nazwa_ul).trim(),
      buildingNo: row.nr_domu == null ? null : String(row.nr_domu).trim(),
      propertyId: propertyId || null,
      parcelNumber: row.nr_dzialki == null ? null : String(row.nr_dzialki).trim(),
      distributionPoint: osdByProperty.get(propertyId) ?? null,
      lat: null,
      lng: null,
      householdCount: 0,
      businessUnitCount: 0,
    });
  }

  return {
    addresses,
    totalPaRows: paRows.length,
    totalLokaleRows,
    skippedNoGeom: 0,
    skippedBadGeom: 0,
  };
}

function extractCableEntries(db: Database.Database): {
  totalCableRows: number;
  dacToAddressCableEntries: string[];
  adssToAddressCableEntries: string[];
} {
  if (!tableExists(db, 'Kable Światłowodowe') && !tableExists(db, 'Kable Swiatlowodowe')) {
    return { totalCableRows: 0, dacToAddressCableEntries: [], adssToAddressCableEntries: [] };
  }

  const tableName = tableExists(db, 'Kable Światłowodowe') ? 'Kable Światłowodowe' : 'Kable Swiatlowodowe';
  const rows = db.prepare(`SELECT * FROM ${q(tableName)}`).all() as Array<Record<string, unknown>>;
  const dac = new Set<string>();
  const adss = new Set<string>();

  for (const row of rows) {
    const elementType = row.typ_elementu == null ? '' : String(row.typ_elementu);
    const destination = row.do == null ? '' : String(row.do);
    const entry = normalizeCableAddressEntry(destination);
    if (!entry) continue;

    if (/Kabel doziemny|Kabel w kanalizacji/i.test(elementType)) {
      dac.add(entry);
    } else if (/Kabel napowietrzny/i.test(elementType)) {
      adss.add(entry);
    }
  }

  return {
    totalCableRows: rows.length,
    dacToAddressCableEntries: [...dac].sort((a, b) => a.localeCompare(b, 'pl')),
    adssToAddressCableEntries: [...adss].sort((a, b) => a.localeCompare(b, 'pl')),
  };
}

function extractProjectName(db: Database.Database): string | null {
  try {
    if (tableExists(db, 'npd_suite_metadane')) {
      const rows = db.prepare(`SELECT klucz, wartosc FROM ${q('npd_suite_metadane')}`).all() as Array<Record<string, unknown>>;
      
      const sapOpisRow = rows.find(r => typeof r.klucz === 'string' && r.klucz.toLowerCase() === 'sap_opis');
      if (sapOpisRow && typeof sapOpisRow.wartosc === 'string' && sapOpisRow.wartosc.trim().length > 0) {
        return sapOpisRow.wartosc.trim();
      }
      
      const glProjectRow = rows.find(r => typeof r.klucz === 'string' && r.klucz.toLowerCase() === 'gl_project');
      if (glProjectRow && typeof glProjectRow.wartosc === 'string' && glProjectRow.wartosc.trim().length > 0) {
        return glProjectRow.wartosc.trim();
      }
    }

    const allTables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as {name: string}[];
    
    // Próba 1: Szukamy po nazwach kolumn (sap, projekt, zadanie)
    for (const t of allTables) {
      if (t.name.startsWith('sqlite_') || t.name.startsWith('gpkg_') || t.name.startsWith('rtree_')) continue;
      
      const rows = db.prepare(`SELECT * FROM ${q(t.name)} LIMIT 1`).all() as Array<Record<string, unknown>>;
      if (rows.length === 0) continue;
      
      for (const [key, value] of Object.entries(rows[0])) {
        const k = key.toLowerCase();
        if ((k.includes('sap') || k.includes('zadania') || k.includes('projekt')) && typeof value === 'string' && value.length > 3) {
          return value.trim();
        }
      }
    }
    
    // Próba 2: Szukamy jakiejkolwiek wartości tekstowej, która wygląda jak kod projektu (np. Q_KPO_..., dużo podkreślników)
    for (const t of allTables) {
      if (t.name.startsWith('sqlite_') || t.name.startsWith('gpkg_') || t.name.startsWith('rtree_')) continue;
      
      const rows = db.prepare(`SELECT * FROM ${q(t.name)} LIMIT 50`).all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        for (const value of Object.values(row)) {
          if (typeof value === 'string') {
            const v = value.trim();
            if (/^Q_(KPO|SI)_[A-Z0-9_]+$/i.test(v)) return v;
            if (v.length > 15 && (v.match(/_/g) || []).length >= 4 && !v.includes(' ')) return v;
          }
        }
      }
    }
  } catch (err) {}
  
  return null;
}

function extractSplices(db: Database.Database): MufaEntry[] {
  const tables = ['Urządzenia Pasywne', '_Urządzenia Pasywne', 'Urzadzenia Pasywne', '_Urzadzenia Pasywne'];
  const results = new Map<string, MufaEntry>();

  for (const tableName of tables) {
    if (!tableExists(db, tableName)) continue;
    
    try {
      // Wyciągamy wszystko, co może mieć nazwę z ZS
      const rows = db.prepare(`SELECT * FROM ${q(tableName)}`).all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        const modyfikacja = typeof row.modyfikacja === 'string' ? row.modyfikacja.trim() : null;
        if (modyfikacja === 'Istniejący' || modyfikacja === 'Istniejacy') {
          continue; // Pomiń mufy istniejące
        }

        const wezel = typeof row.wezel === 'string' ? row.wezel.trim() : null;
        const oznaczenie = typeof row.oznaczenie === 'string' ? row.oznaczenie.trim() : wezel;
        
        const hasZS = wezel?.includes('ZS') || oznaczenie?.includes('ZS');
        const hasOSD = wezel?.includes('OSD') || oznaczenie?.includes('OSD');
        
        // Według uwag: ma być to ZS (np. po nazwie wezła ZS00004), a nie OSD.
        if (wezel && hasZS && !hasOSD) {
          results.set(wezel, { wezel, oznaczenie: oznaczenie || wezel });
        }
      }
    } catch (err) {}
  }

  const zsList = Array.from(results.values()).sort((a, b) => a.wezel.localeCompare(b.wezel, 'pl'));
  return zsList;
}

export function extractSplicePlaceholder(): void {} // keep lint happy

function extractProjectDefinition(db: Database.Database): string | null {
  // Pattern: letter/digits e.g. X/04009120 or F/04001314
  const codePattern = /^[A-Z]\/(\d{6,10})$/;

  const candidateTables = ['_Obiekty', 'Obiekty'];
  for (const tableName of candidateTables) {
    if (!tableExists(db, tableName)) continue;
    try {
      const rows = db.prepare(`SELECT * FROM ${q(tableName)} LIMIT 200`).all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        for (const [key, value] of Object.entries(row)) {
          if (key === 'did' || key === 'geom') continue;
          if (typeof value === 'string' && codePattern.test(value.trim())) {
            return value.trim();
          }
        }
      }
    } catch (e) {}
  }

  // Fallback: scan all tables
  try {
    const allTables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as {name: string}[];
    for (const t of allTables) {
      if (t.name.startsWith('sqlite_') || t.name.startsWith('gpkg_') || t.name.startsWith('rtree_')) continue;
      if (candidateTables.includes(t.name)) continue;
      const rows = db.prepare(`SELECT * FROM ${q(t.name)} LIMIT 100`).all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        for (const [key, value] of Object.entries(row)) {
          if (key === 'did' || key === 'geom') continue;
          if (typeof value === 'string' && codePattern.test(value.trim())) {
            return value.trim();
          }
        }
      }
    }
  } catch (e) {}

  return null;
}

export function extractGpkg(filePath: string): GpkgExtractionResult {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Plik GPKG nie istnieje: ${filePath}`);
  }

  const db = new Database(filePath, { readonly: true });
  try {
    const addresses = extractAddresses(db);
    const cables = extractCableEntries(db);
    const splitterCount = countSplitters(db);
    const suggestedProjectName = extractProjectName(db);
    const suggestedProjectDefinition = extractProjectDefinition(db);
    const splices = extractSplices(db);

    return {
      suggestedProjectName,
      suggestedProjectDefinition,
      splices,
      addresses: addresses.addresses,
      dacToAddressCableEntries: cables.dacToAddressCableEntries,
      adssToAddressCableEntries: cables.adssToAddressCableEntries,
      splitterCount,
      suggestedSplitterTopology: inferSplitterTopology(splitterCount),
      totalPaRows: addresses.totalPaRows,
      totalLokaleRows: addresses.totalLokaleRows,
      totalCableRows: cables.totalCableRows,
      skippedNoGeom: addresses.skippedNoGeom,
      skippedBadGeom: addresses.skippedBadGeom,
    };
  } finally {
    db.close();
  }
}
