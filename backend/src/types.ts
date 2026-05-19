export type ProjectType = 'SI' | 'KPO';
export type SplitterTopology = 'SINGLE' | 'CASCADE';
export type SplitterTopologySource = 'AUTO' | 'MANUAL';
export type ChecklistNodeStatus = 'OPEN' | 'COMPLETE' | 'NOT_APPLICABLE';
export type ChecklistNodeType = 'STATIC' | 'DISTRIBUTION' | 'ADDRESS' | 'CABLE_RESERVE';
export type ChecklistNodeSource = 'GPKG' | 'MANUAL' | 'SYSTEM';
export type CableRoutingType = 'underground' | 'aerial' | 'existing_duct';
export type MapNoteTargetType = 'cable' | 'node' | 'address' | 'polygon' | 'free';

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
  routingType: CableRoutingType;
}

export interface MapPolygonInput {
  osdName: string;
  label: string | null;
  geojson: Record<string, unknown>;
  households: number | null;
  paCount: number | null;
  cableRef: string | null;
}

export interface MapTrunkCableInput {
  cableType: string;
  fromNode: string;
  toNode: string;
  osdName: string;
  geojson: Record<string, unknown>;
  rawName: string | null;
  routingType?: CableRoutingType;
}

export interface MapInfraNodeInput {
  nodeType: 'OSD' | 'OPP' | 'ZS';
  name: string;
  label: string | null;
  lat: number;
  lng: number;
}

export type MapCableStatus = 'PENDING' | 'DUCT_READY' | 'PULLED' | 'WELDED' | 'SUSPENDED';
export type MapNodeStatus = 'PENDING' | 'WELDED';

export interface ProjectMapAddress {
  id: string;
  label: string;
  city: string;
  street: string;
  buildingNo: string | null;
  distributionPoint: string | null;
  lat: number;
  lng: number;
  reservePhotoCount: number;
  hasReservePhoto: boolean;
}

export interface ProjectMapPolygon {
  id: string;
  osdName: string;
  label: string | null;
  geojson: Record<string, unknown>;
  households: number | null;
  paCount: number | null;
  cableRef: string | null;
  addressTotal: number;
  addressWithReservePhoto: number;
}

export interface ProjectMapCable {
  id: string;
  cableType: string;
  fromNode: string;
  toNode: string;
  osdName: string;
  geojson: Record<string, unknown>;
  rawName: string | null;
  routingType: CableRoutingType;
  status: MapCableStatus;
}

export interface ProjectMapInfraNode {
  id: string;
  nodeType: 'OSD' | 'OPP' | 'ZS';
  name: string;
  label: string | null;
  lat: number;
  lng: number;
  status: MapNodeStatus;
  hasPhoto: boolean;
}

export interface ProjectMapNotePhoto {
  id: string;
  noteId: string;
  sourceFileName: string;
  storedFileName: string;
  storagePath: string;
  thumbnailPath: string | null;
  mimeType: string;
  fileSize: number | null;
  lat: number | null;
  lng: number | null;
  capturedAt: string | null;
  uploadedAt: string;
}

export interface ProjectMapNote {
  id: string;
  targetType: MapNoteTargetType;
  targetId: string | null;
  targetLabel: string | null;
  body: string;
  lat: number | null;
  lng: number | null;
  photoCount: number;
  photos: ProjectMapNotePhoto[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMapRecord {
  addresses: ProjectMapAddress[];
  polygons: ProjectMapPolygon[];
  trunkCables: ProjectMapCable[];
  infraNodes: ProjectMapInfraNode[];
  notes: ProjectMapNote[];
}

export interface GpkgExtractionResult {
  suggestedProjectName: string | null;
  suggestedProjectDefinition: string | null;
  splices: MufaEntry[];
  addresses: AddressInput[];
  polygons: MapPolygonInput[];
  trunkCables: MapTrunkCableInput[];
  infraNodes: MapInfraNodeInput[];
  passiveInfraNodes: MapInfraNodeInput[];
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
  source: ChecklistNodeSource;
  addressId: string | null;
  sortOrder: number;
  minPhotos: number;
  acceptsPhotos: boolean;
  status: ChecklistNodeStatus;
  notApplicableReason: string | null;
  photoCount: number;
}
