export type ProjectType = 'SI' | 'KPO';
export type SplitterTopology = 'SINGLE' | 'CASCADE';
export type SplitterTopologySource = 'AUTO' | 'MANUAL';
export type ChecklistNodeStatus = 'OPEN' | 'COMPLETE' | 'NOT_APPLICABLE';
export type ChecklistNodeType = 'STATIC' | 'DISTRIBUTION' | 'ADDRESS' | 'CABLE_RESERVE';

export interface MufaEntry {
  wezel: string;
  oznaczenie: string;
}

export interface AddressInput {
  city: string;
  street: string;
  buildingNo: string | null;
  propertyId: string | null;
  parcelNumber: string | null;
  distributionPoint: string | null;
  lat: number | null;
  lng: number | null;
  householdCount: number;
  businessUnitCount: number;
}

export interface CableEntry {
  addressName: string;
  routingType: 'underground' | 'aerial';
}

export interface GpkgExtractionResult {
  suggestedProjectName: string | null;
  suggestedProjectDefinition: string | null;
  splices: MufaEntry[];
  addresses: AddressInput[];
  dacToAddressCableEntries: string[];
  adssToAddressCableEntries: string[];
  splitterCount: number;
  suggestedSplitterTopology: SplitterTopology;
  totalPaRows: number;
  totalLokaleRows: number;
  totalCableRows: number;
  skippedNoGeom: number;
  skippedBadGeom: number;
}

export interface ProjectRecord {
  id: string;
  name: string;
  projectDefinition: string | null;
  projectType: ProjectType;
  splitterTopology: SplitterTopology;
  splitterCount: number;
  splitterTopologySource: SplitterTopologySource;
  gpkgFileName: string;
  baseFolder: string;
  addressCount: number;
  dacToAddressCableCount: number;
  adssToAddressCableCount: number;
  progressDone: number;
  progressTotal: number;
  status: 'W trakcie' | 'Kompletne';
  createdAt: string;
  updatedAt: string;
}

export interface ChecklistNodeRecord {
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
  status: ChecklistNodeStatus;
  notApplicableReason: string | null;
  photoCount: number;
}
