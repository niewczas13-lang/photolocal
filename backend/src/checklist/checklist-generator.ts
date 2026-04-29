import { randomUUID } from 'node:crypto';
import type { AddressInput, ChecklistNodeType, MufaEntry, ProjectType, SplitterTopology } from '../types.js';
import { safeFolderName, toAddressFolderName } from '../utils/path-names.js';

export interface ChecklistAddress extends AddressInput {
  id: string;
}

export interface GenerateChecklistInput {
  projectId: string;
  projectName: string;
  projectType: ProjectType;
  splitterTopology: SplitterTopology;
  addresses: ChecklistAddress[];
  splices?: MufaEntry[];
  dacToAddressCableEntries: string[];
  adssToAddressCableEntries: string[];
}

export interface GeneratedChecklistNode {
  id: string;
  projectId: string;
  parentId: string | null;
  name: string;
  path: string;
  nodeType: ChecklistNodeType;
  addressId: string | null;
  sortOrder: number;
  minPhotos: number;
  acceptsPhotos: boolean;
}

function normalizeDistributionPointName(value: string | null): string {
  if (!value) return 'Bez_DP';
  return value.trim();
}

function isOpp(name: string): boolean {
  return /OPP/i.test(name);
}

function isOsd(name: string): boolean {
  return /OSD/i.test(name);
}

function getAddressKey(address: ChecklistAddress): string {
  const parts = [address.street, address.buildingNo].filter(Boolean);
  if (parts.length === 0) {
    parts.push(address.city);
  }
  return parts.join(' ').replace(/^UL\.\s*/i, '').replace(/\s+/g, ' ').trim().toUpperCase();
}

export function generateChecklistNodes(input: GenerateChecklistInput): GeneratedChecklistNode[] {
  const nodes: GeneratedChecklistNode[] = [];
  const pathToId = new Map<string, string>();

  const addNode = (
    parentId: string | null,
    name: string,
    path: string,
    nodeType: ChecklistNodeType,
    addressId: string | null,
    sortOrder: number,
    minPhotos: number,
    acceptsPhotos: boolean,
  ): string => {
    const existing = pathToId.get(path);
    if (existing) return existing;
    const id = randomUUID();
    pathToId.set(path, id);
    nodes.push({
      id,
      projectId: input.projectId,
      parentId,
      name,
      path,
      nodeType,
      addressId,
      sortOrder,
      minPhotos,
      acceptsPhotos,
    });
    return id;
  };

  if (input.splices && input.splices.length > 0) {
    for (const splice of input.splices) {
      const folderName = `01_${safeFolderName(splice.wezel)}`;
      const zsId = addNode(null, splice.wezel, folderName, 'STATIC', null, 0, 0, false);
      addNode(zsId, 'Zdjecia', `${folderName}/Zdjecia`, 'STATIC', null, 0, 1, true);
    }
  }

  const wykopyId = addNode(null, 'Wykopy/Przeciski', 'Wykopy_Przeciski', 'STATIC', null, 1, 0, false);
  addNode(wykopyId, 'Prace_zanikowe', 'Wykopy_Przeciski/Prace_zanikowe', 'STATIC', null, 0, 1, true);

  const pgeId = addNode(null, 'Podwieszenie_kabla_PGE', 'Podwieszenie_kabla_PGE', 'STATIC', null, 2, 0, false);
  addNode(pgeId, 'Budowa_liniowa', 'Podwieszenie_kabla_PGE/Budowa_liniowa', 'STATIC', null, 0, 1, true);

  const podwId = addNode(null, 'Podwieszenie_kabli', 'Podwieszenie_kabli', 'STATIC', null, 3, 0, false);
  addNode(podwId, 'Budowa_liniowa', 'Podwieszenie_kabli/Budowa_liniowa', 'STATIC', null, 0, 1, true);

  const pomiaryId = addNode(null, 'Pomiary_mocy', 'Pomiary_mocy', 'STATIC', null, 4, 0, false);

  const notatkiId = addNode(null, 'Notatki_z_budowy', 'Notatki_z_budowy', 'STATIC', null, 5, 0, false);
  addNode(notatkiId, 'Zdjecia', 'Notatki_z_budowy/Zdjecia', 'STATIC', null, 0, 1, true);

  const dpGroups = new Map<string, ChecklistAddress[]>();
  for (const address of input.addresses) {
    const dp = normalizeDistributionPointName(address.distributionPoint);
    const group = dpGroups.get(dp) ?? [];
    group.push(address);
    dpGroups.set(dp, group);
  }

  let dpSort = 100;
  for (const dp of dpGroups.keys()) {
    const safeDp = safeFolderName(dp);
    const dpId = addNode(null, dp, safeDp, 'DISTRIBUTION', null, dpSort++, 0, false);
    addNode(dpId, 'Szczegoly_skrzynki', `${safeDp}/Szczegoly_skrzynki`, 'DISTRIBUTION', null, 0, 1, true);
  }

  let pomSort = 0;
  for (const dp of dpGroups.keys()) {
    const safeDp = safeFolderName(dp);
    if (input.splitterTopology === 'SINGLE' && isOpp(dp)) {
      addNode(pomiaryId, dp, `Pomiary_mocy/${safeDp}`, 'DISTRIBUTION', null, pomSort++, 1, true);
    }
    if (input.splitterTopology === 'CASCADE' && (isOpp(dp) || isOsd(dp))) {
      addNode(pomiaryId, dp, `Pomiary_mocy/${safeDp}`, 'DISTRIBUTION', null, pomSort++, 1, true);
    }
  }
  if (pomSort === 0) {
    addNode(pomiaryId, 'Komplet', 'Pomiary_mocy/Komplet', 'STATIC', null, 0, 1, true);
  }

  const dacRoot = addNode(
    null,
    'Zapasy_kabli_instalacyjnych',
    'Zapasy_kabli_instalacyjnych',
    'STATIC',
    null,
    6,
    0,
    false,
  );

  let dacDpSort = 0;
  for (const [dp, addresses] of dpGroups) {
    const safeDp = safeFolderName(dp);
    let dpId: string | null = null;
    let addrSort = 0;
    for (const address of addresses) {
      const addrKey = getAddressKey(address);
      const isDac = input.dacToAddressCableEntries.some((entry) => entry.includes(addrKey));
      if (!isDac) continue;

      const addressName = toAddressFolderName(address.street, address.buildingNo);
      dpId ??= addNode(dacRoot, dp, `Zapasy_kabli_instalacyjnych/${safeDp}`, 'DISTRIBUTION', null, dacDpSort++, 0, false);
      addNode(dpId, addressName, `Zapasy_kabli_instalacyjnych/${safeDp}/${addressName}`, 'CABLE_RESERVE', address.id, addrSort++, 1, true);
    }
  }

  if (input.projectType === 'KPO') {
    const adssRoot = addNode(
      null,
      'Zapasy_kabli_napowietrznych',
      'Zapasy_kabli_napowietrznych',
      'STATIC',
      null,
      7,
      0,
      false,
    );
    let adssDpSort = 0;
    for (const [dp, addresses] of dpGroups) {
      const safeDp = safeFolderName(dp);
      let dpId: string | null = null;
      let addrSort = 0;
      for (const address of addresses) {
        const addrKey = getAddressKey(address);
        const isAdss = input.adssToAddressCableEntries.some((entry) => entry.includes(addrKey));
        if (!isAdss) continue;

        const addressName = toAddressFolderName(address.street, address.buildingNo);
        dpId ??= addNode(adssRoot, dp, `Zapasy_kabli_napowietrznych/${safeDp}`, 'DISTRIBUTION', null, adssDpSort++, 0, false);
        addNode(dpId, addressName, `Zapasy_kabli_napowietrznych/${safeDp}/${addressName}`, 'CABLE_RESERVE', address.id, addrSort++, 1, true);
      }
    }
  }

  return nodes;
}
