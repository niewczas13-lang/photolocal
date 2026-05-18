import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  CheckCheck,
  ChevronsDownUp,
  ChevronsUpDown,
  ImagePlus,
  Search,
  Pencil,
  Check,
  Image as ImageIcon,
  AlertCircle,
  Inbox,
  Download,
  ClipboardCheck,
  Settings,
  RefreshCw,
  FolderPlus,
  Map,
} from 'lucide-react';
import { api } from '../api';
import type { ChatBatch, ChecklistNode, ChecklistNodeDetail, ChecklistPhoto, ProjectSummary, ReserveLocation } from '../types';
import ChatImportPanel from './ChatImportPanel';
import ChatReviewPanel from './ChatReviewPanel';
import ChecklistTree from './ChecklistTree';
import MissingPanel from './MissingPanel';
import PhotoDropzone from './PhotoDropzone';
import type { ProjectTab } from '../app-routing';

import { Button } from './ui/button';
import { Input } from './ui/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import { Badge } from './ui/badge';
import { Card, CardContent } from './ui/card';

interface ProjectViewProps {
  project: ProjectSummary;
  initialTab: ProjectTab;
  onBack: () => void;
  onTabChange: (tab: ProjectTab) => void;
  onOpenMap: () => void;
  onOpenSettings: () => void;
  onRename: (newName: string) => void;
  onProjectUpdated: (project: ProjectSummary) => void;
}

function findNode(nodes: ChecklistNode[], nodeId: string): ChecklistNode | null {
  for (const node of nodes) {
    if (node.id === nodeId) return node;
    const child = findNode(node.children, nodeId);
    if (child) return child;
  }
  return null;
}

function collectExpandableIds(nodes: ChecklistNode[]): string[] {
  return nodes.flatMap((node) => [
    ...(node.children.length > 0 ? [node.id] : []),
    ...collectExpandableIds(node.children),
  ]);
}

function collectMissingNodes(nodes: ChecklistNode[]): ChecklistNode[] {
  return nodes.flatMap((node) => {
    const self = node.acceptsPhotos && node.status === 'OPEN' && node.photoCount < node.minPhotos ? [node] : [];
    return [...self, ...collectMissingNodes(node.children)];
  });
}

function collectContainerNodes(nodes: ChecklistNode[]): ChecklistNode[] {
  return nodes.flatMap((node) => [
    ...(!node.acceptsPhotos ? [node] : []),
    ...collectContainerNodes(node.children),
  ]);
}

function collectAncestorIds(nodes: ChecklistNode[], targetId: string, trail: string[] = []): string[] | null {
  for (const node of nodes) {
    if (node.id === targetId) return trail;
    const result = collectAncestorIds(node.children, targetId, [...trail, node.id]);
    if (result) return result;
  }
  return null;
}

function normalize(s: string): string {
  return s.replace(/_/g, ' ').toLowerCase();
}

function filterTree(nodes: ChecklistNode[], query: string): { filtered: ChecklistNode[]; autoExpandedIds: string[] } {
  const normalizedQuery = normalize(query.trim());
  if (!normalizedQuery) return { filtered: nodes, autoExpandedIds: [] };

  const autoExpandedIds = new Set<string>();

  const visit = (items: ChecklistNode[]): ChecklistNode[] =>
    items.flatMap((node) => {
      const children = visit(node.children);
      const isMatch =
        normalize(node.name).includes(normalizedQuery) ||
        normalize(node.path).includes(normalizedQuery);

      if (!isMatch && children.length === 0) return [];
      if (children.length > 0) autoExpandedIds.add(node.id);

      return [{ ...node, children }];
    });

  return { filtered: visit(nodes), autoExpandedIds: [...autoExpandedIds] };
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Nieznany blad';
}

export default function ProjectView({
  project,
  initialTab,
  onBack,
  onTabChange,
  onOpenMap,
  onOpenSettings,
  onRename,
  onProjectUpdated,
}: ProjectViewProps) {
  const projectId = project.id;
  const [nodes, setNodes] = useState<ChecklistNode[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [nodeDetail, setNodeDetail] = useState<ChecklistNodeDetail | null>(null);
  const [reserveLocation, setReserveLocation] = useState<ReserveLocation>('Doziemny');
  const [uploading, setUploading] = useState(false);
  const [search, setSearch] = useState('');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<Set<string>>(new Set());
  const [movingPhotos, setMovingPhotos] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(project.name);
  const [savingName, setSavingName] = useState(false);
  const [activeTab, setActiveTab] = useState<ProjectTab>(initialTab);
  const [chatBatches, setChatBatches] = useState<ChatBatch[]>([]);
  const [recalculateFile, setRecalculateFile] = useState<File | null>(null);
  const [recalculateTopology, setRecalculateTopology] = useState<'AUTO' | 'SINGLE' | 'CASCADE'>(
    project.splitterTopologySource === 'MANUAL' ? project.splitterTopology : 'AUTO',
  );
  const [recalculating, setRecalculating] = useState(false);
  const [recalculateResult, setRecalculateResult] = useState<string | null>(null);
  const [isAddingFolder, setIsAddingFolder] = useState(false);
  const [addFolderName, setAddFolderName] = useState('');
  const [addFolderParentId, setAddFolderParentId] = useState('');
  const [addFolderKind, setAddFolderKind] = useState<'photo' | 'reserve' | 'container'>('photo');
  const [savingFolder, setSavingFolder] = useState(false);

  const handleRename = async () => {
    if (!draftName.trim() || draftName.trim() === project.name) {
      setEditingName(false);
      setDraftName(project.name);
      return;
    }
    setSavingName(true);
    try {
      const updatedProject = await api.renameProject(projectId, draftName.trim());
      onProjectUpdated(updatedProject);
      onRename(updatedProject.name);
      setEditingName(false);
    } catch (err) {
      console.error(err);
      alert('Blad podczas zmiany nazwy');
    } finally {
      setSavingName(false);
    }
  };

  const selectedNode = useMemo(
    () => (selectedNodeId ? findNode(nodes, selectedNodeId) : null),
    [nodes, selectedNodeId],
  );

  const refreshChecklist = async (nextSelectedNodeId: string | null | undefined = selectedNodeId) => {
    const nextNodes = await api.getChecklist(projectId);
    setNodes(nextNodes);

    if (!nextSelectedNodeId) return;

    const refreshedNode = findNode(nextNodes, nextSelectedNodeId);
    setSelectedNodeId(refreshedNode?.id ?? null);

    const ancestorIds = collectAncestorIds(nextNodes, nextSelectedNodeId) ?? [];
    if (ancestorIds.length > 0) {
      setExpandedIds((current) => new Set([...current, ...ancestorIds]));
    }
  };

  const refreshNodeDetail = async (nodeId: string | null) => {
    if (!nodeId) {
      setNodeDetail(null);
      setSelectedPhotoIds(new Set());
      return;
    }

    const detail = await api.getChecklistNode(projectId, nodeId);
    setNodeDetail(detail);
    setSelectedPhotoIds(new Set());
  };

  const refreshChatBatches = async () => {
    const batches = await api.listChatBatches(projectId);
    setChatBatches(batches);
  };

  useEffect(() => {
    void refreshChecklist(null);
    void refreshChatBatches();
  }, [projectId]);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab, projectId]);

  useEffect(() => {
    setDraftName(project.name);
    setRecalculateTopology(project.splitterTopologySource === 'MANUAL' ? project.splitterTopology : 'AUTO');
  }, [project.name, project.splitterTopology, project.splitterTopologySource]);

  useEffect(() => {
    void refreshNodeDetail(selectedNodeId);
  }, [projectId, selectedNodeId]);

  const { filtered, autoExpandedIds } = useMemo(() => filterTree(nodes, search), [nodes, search]);
  const renderedExpandedIds = useMemo(
    () => new Set([...expandedIds, ...autoExpandedIds]),
    [expandedIds, autoExpandedIds],
  );
  const missingCount = useMemo(() => collectMissingNodes(nodes).length, [nodes]);
  const containerNodes = useMemo(() => collectContainerNodes(nodes), [nodes]);

  const handleNodeSelect = (node: ChecklistNode) => {
    setSelectedNodeId(node.id);
    const ancestors = collectAncestorIds(nodes, node.id) ?? [];
    setExpandedIds((current) => new Set([...current, ...ancestors]));
    if (node.path.startsWith('Zapasy_kabli_napowietrznych')) {
      setReserveLocation('Napowietrzny');
    }
    setActiveTab('photos');
    onTabChange('photos');
  };

  const openAddFolderForm = () => {
    setIsAddingFolder(true);
    setAddFolderName('');
    setAddFolderKind('photo');
    setAddFolderParentId(selectedNode && !selectedNode.acceptsPhotos ? selectedNode.id : '');
  };

  const handleCreateChecklistNode = async () => {
    if (!addFolderName.trim()) return;

    const input =
      addFolderKind === 'container'
        ? {
            name: addFolderName.trim(),
            parentId: addFolderParentId || null,
            nodeType: 'STATIC' as const,
            minPhotos: 0,
            acceptsPhotos: false,
          }
        : addFolderKind === 'reserve'
          ? {
              name: addFolderName.trim(),
              parentId: addFolderParentId || null,
              nodeType: 'CABLE_RESERVE' as const,
              minPhotos: 1,
              acceptsPhotos: true,
            }
          : {
              name: addFolderName.trim(),
              parentId: addFolderParentId || null,
              nodeType: 'STATIC' as const,
              minPhotos: 1,
              acceptsPhotos: true,
            };

    setSavingFolder(true);
    try {
      const created = await api.createChecklistNode(projectId, input);
      await refreshChecklist(created.id);
      await refreshNodeDetail(created.id);
      setIsAddingFolder(false);
      setAddFolderName('');
    } catch (err) {
      console.error(err);
      alert(`Blad podczas dodawania folderu:\n${getErrorMessage(err)}`);
    } finally {
      setSavingFolder(false);
    }
  };

  const handleAcceptChatBatch = async (
    batchId: string,
    checklistNodeIds: string[],
    nextReserveLocation: ReserveLocation | null,
    fileIds: string[],
  ) => {
    try {
      await api.acceptChatBatch(projectId, batchId, checklistNodeIds, nextReserveLocation, fileIds);
      await refreshChecklist(selectedNodeId);
      await refreshNodeDetail(selectedNodeId);
      await refreshChatBatches();
    } catch (err) {
      console.error(err);
      alert(`Blad podczas akceptacji paczki z czatu:\n${getErrorMessage(err)}`);
    }
  };

  const handleRejectChatBatch = async (batchId: string) => {
    try {
      await api.rejectChatBatch(projectId, batchId, 'Odrzucone w review');
      await refreshChatBatches();
    } catch (err) {
      console.error(err);
      alert('Blad podczas odrzucania paczki z czatu');
    }
  };

  const handleFiles = async (files: File[]) => {
    if (!selectedNode || files.length === 0) return;

    setUploading(true);
    try {
      const location = selectedNode.path.startsWith('Zapasy_kabli_instalacyjnych') ||
        selectedNode.path.startsWith('Zapasy_kabli_napowietrznych')
        ? reserveLocation
        : null;
      for (const file of files) {
        await api.uploadPhoto(projectId, selectedNode.id, file, location);
      }
      await refreshChecklist(selectedNode.id);
      await refreshNodeDetail(selectedNode.id);
    } catch (err) {
      console.error(err);
      alert('Blad podczas zapisywania zdjec');
    } finally {
      setUploading(false);
    }
  };

  const handleBulkMove = async (nextLocation: ReserveLocation) => {
    if (!selectedNodeId || selectedPhotoIds.size === 0) return;

    setMovingPhotos(true);
    try {
      await api.reclassifyPhotos(projectId, selectedNodeId, [...selectedPhotoIds], nextLocation);
      await refreshChecklist(selectedNodeId);
      await refreshNodeDetail(selectedNodeId);
      setReserveLocation(nextLocation);
    } catch (err) {
      console.error(err);
      alert('Blad podczas przenoszenia zdjec');
    } finally {
      setMovingPhotos(false);
    }
  };

  const handleRecalculateChecklist = async () => {
    if (!recalculateFile) return;

    setRecalculating(true);
    setRecalculateResult(null);
    try {
      const result = await api.recalculateChecklist(
        projectId,
        recalculateFile,
        project.projectType,
        recalculateTopology,
      );
      onProjectUpdated(result.project);
      await refreshChecklist(selectedNodeId);
      await refreshNodeDetail(selectedNodeId);
      setRecalculateResult(
        `Dodano ${result.addedNodes}, odswiezono ${result.updatedNodes}, usunieto stare bez zdjec ${result.removedStaleNodes}, zostawiono stare ze zdjeciami ${result.preservedAssignedStaleNodes}. Adresy: nowe ${result.addedAddresses}, rozpoznane ${result.reusedAddresses}.`,
      );
      setRecalculateFile(null);
    } catch (err) {
      console.error(err);
      alert('Blad podczas przeliczania checklisty');
    } finally {
      setRecalculating(false);
    }
  };

  const toggleNode = (nodeId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  };

  const togglePhotoSelection = (photoId: string) => {
    setSelectedPhotoIds((current) => {
      const next = new Set(current);
      if (next.has(photoId)) {
        next.delete(photoId);
      } else {
        next.add(photoId);
      }
      return next;
    });
  };

  const allVisibleNodePhotosSelected =
    nodeDetail?.photos.length && selectedPhotoIds.size === nodeDetail.photos.length;

  return (
    <div className="flex flex-col h-[calc(100vh-64px)] overflow-hidden">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between p-4 px-6 border-b border-border bg-background/50 gap-4 shrink-0">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" title="Lista zlecen" onClick={onBack}>
            <ArrowLeft size={18} />
          </Button>
          <div className="min-w-0">
            {project.projectDefinition && (
              <div className="mb-1 flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">Definicja projektu</span>
                <Badge variant="outline" className="font-mono text-xs">
                  {project.projectDefinition}
                </Badge>
              </div>
            )}
            {editingName ? (
              <div className="flex items-center gap-2">
                <Input
                  autoFocus
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleRename();
                    if (e.key === 'Escape') {
                      setEditingName(false);
                      setDraftName(project.name);
                    }
                  }}
                  className="h-8 w-64"
                />
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={savingName}
                  onClick={handleRename}
                  className="h-8 w-8 text-green-500 hover:text-green-600"
                >
                  <Check size={16} />
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2 group">
                <h2 className="text-xl font-bold tracking-tight truncate">{project.name}</h2>
                <Button size="icon" variant="ghost" className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity" onClick={() => setEditingName(true)}>
                  <Pencil size={12} />
                </Button>
              </div>
            )}
            <p className="text-sm text-muted-foreground mt-0.5 flex items-center gap-2">
              {project.status === 'Kompletne' && <Badge className="bg-green-600 hover:bg-green-700">Ukończone</Badge>}
              {missingCount === 0 ? 'Checklista gotowa' : `Brakuje jeszcze ${missingCount} punktów`}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={onOpenMap}>
            <Map size={15} />
            Mapa + zadania
          </Button>
          <Button variant="outline" size="sm" onClick={onOpenSettings}>
            <Settings size={15} />
            Ustawienia
          </Button>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex flex-1 overflow-hidden">
        
        {/* Left Column - Checklist */}
        <div className="w-80 md:w-96 border-r border-border flex flex-col bg-muted/10 shrink-0">
          <div className="p-4 flex flex-col gap-3 shrink-0">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold leading-none">Checklista</p>
                <p className="text-xs text-muted-foreground mt-1">{nodes.length} folderow glownych</p>
              </div>
              <Button variant="outline" size="sm" onClick={openAddFolderForm}>
                <FolderPlus size={14} className="mr-1.5" />
                Dodaj
              </Button>
            </div>
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input 
                value={search} 
                onChange={(e) => setSearch(e.target.value)} 
                placeholder="Szukaj (OSD, adres, ścieżka)..." 
                className="pl-9 h-9"
              />
            </div>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" className="flex-1 text-xs h-8" onClick={() => setExpandedIds(new Set(collectExpandableIds(nodes)))}>
                <ChevronsUpDown size={14} className="mr-1.5" />
                Rozwiń wszystko
              </Button>
              <Button variant="secondary" size="sm" className="flex-1 text-xs h-8" onClick={() => setExpandedIds(new Set())}>
                <ChevronsDownUp size={14} className="mr-1.5" />
                Zwiń wszystko
              </Button>
            </div>
            {isAddingFolder && (
              <div className="rounded-lg border border-border bg-background p-3 flex flex-col gap-2">
                <Input
                  value={addFolderName}
                  onChange={(event) => setAddFolderName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void handleCreateChecklistNode();
                    if (event.key === 'Escape') setIsAddingFolder(false);
                  }}
                  placeholder="Nazwa nowego folderu"
                  className="h-8"
                />
                <select
                  value={addFolderParentId}
                  onChange={(event) => setAddFolderParentId(event.target.value)}
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                >
                  <option value="">Poziom glowny</option>
                  {containerNodes.map((node) => (
                    <option key={node.id} value={node.id}>
                      {node.path}
                    </option>
                  ))}
                </select>
                <select
                  value={addFolderKind}
                  onChange={(event) => setAddFolderKind(event.target.value as 'photo' | 'reserve' | 'container')}
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                >
                  <option value="photo">Folder ze zdjeciami</option>
                  <option value="reserve">Zapas kabla</option>
                  <option value="container">Folder nadrzedny</option>
                </select>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    className="flex-1"
                    disabled={savingFolder || !addFolderName.trim()}
                    onClick={handleCreateChecklistNode}
                  >
                    {savingFolder ? 'Dodaje...' : 'Zapisz'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={savingFolder}
                    onClick={() => setIsAddingFolder(false)}
                  >
                    Anuluj
                  </Button>
                </div>
              </div>
            )}
          </div>
          
          <div className="flex-1 overflow-y-auto min-h-0">
            <div className="pb-4">
              <ChecklistTree
                nodes={filtered}
                selectedNodeId={selectedNodeId}
                expandedIds={renderedExpandedIds}
                onSelect={handleNodeSelect}
                onToggle={toggleNode}
              />
            </div>
          </div>
        </div>

        {/* Right Column - Work Area */}
        <div className="flex-1 flex flex-col bg-background min-w-0">
          <Tabs
            value={activeTab}
            onValueChange={(value) => {
              const nextTab = value as ProjectTab;
              setActiveTab(nextTab);
              onTabChange(nextTab);
            }}
            className="flex-1 flex flex-col min-h-0"
          >
            <div className="px-6 pt-4 border-b border-border shrink-0">
              <TabsList className="mb-[-1px] rounded-none border-b-0 bg-transparent p-0 gap-6">
                <TabsTrigger 
                  value="photos" 
                  className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-2 py-3 text-sm font-medium shadow-none"
                >
                  <ImageIcon size={16} className="mr-2" />
                  Zdjęcia {nodeDetail ? `(${nodeDetail.photos.length})` : ''}
                </TabsTrigger>
                <TabsTrigger 
                  value="missing" 
                  className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-2 py-3 text-sm font-medium shadow-none"
                >
                  <AlertCircle size={16} className="mr-2" />
                  Braki {missingCount > 0 ? `(${missingCount})` : ''}
                </TabsTrigger>
                <TabsTrigger 
                  value="import" 
                  className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-2 py-3 text-sm font-medium shadow-none"
                >
                  <Download size={16} className="mr-2" />
                  Import z Google Chat
                </TabsTrigger>
                <TabsTrigger 
                  value="ready"
                  className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-2 py-3 text-sm font-medium shadow-none"
                >
                  <ClipboardCheck size={16} className="mr-2" />
                  Do importu {chatBatches.filter((batch) => batch.status === 'READY_FOR_IMPORT').length > 0 ? `(${chatBatches.filter((batch) => batch.status === 'READY_FOR_IMPORT').length})` : ''}
                </TabsTrigger>
                <TabsTrigger 
                  value="review" 
                  className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-2 py-3 text-sm font-medium shadow-none"
                >
                  <Inbox size={16} className="mr-2" />
                  Review {chatBatches.filter((batch) => batch.status === 'PENDING_REVIEW').length > 0 ? `(${chatBatches.filter((batch) => batch.status === 'PENDING_REVIEW').length})` : ''}
                </TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="photos" className="flex-1 flex flex-col min-h-0 mt-0 data-[state=inactive]:hidden">
              <div className="flex-1 overflow-y-auto min-h-0">
                <div className="p-6 max-w-4xl mx-auto w-full flex flex-col gap-8">
                  {/* Dropzone Section */}
                  <div className="flex flex-col gap-4">
                    {selectedNode ? (
                      <>
                        <div className="flex flex-col gap-1">
                          <h3 className="text-lg font-bold">{selectedNode.name}</h3>
                          <p className="text-sm text-muted-foreground">{selectedNode.path}</p>
                        </div>
                        
                        {(selectedNode.path.startsWith('Zapasy_kabli_instalacyjnych') ||
                          selectedNode.path.startsWith('Zapasy_kabli_napowietrznych')) && (
                          <div className="flex flex-col gap-2 p-4 bg-muted/30 border border-border rounded-lg mb-2">
                            <span className="text-sm font-semibold">Wybierz rodzaj zapasu przed wgraniem zdjęcia:</span>
                            <div className="grid grid-cols-3 gap-2">
                              <Button
                                variant={reserveLocation === 'Doziemny' ? 'default' : 'outline'}
                                size="sm"
                                onClick={() => setReserveLocation('Doziemny')}
                              >
                                Zapas doziemny
                              </Button>
                              <Button
                                variant={reserveLocation === 'W studni' ? 'default' : 'outline'}
                                size="sm"
                                onClick={() => setReserveLocation('W studni')}
                              >
                                Zapas w studni
                              </Button>
                              <Button
                                variant={reserveLocation === 'Napowietrzny' ? 'default' : 'outline'}
                                size="sm"
                                onClick={() => setReserveLocation('Napowietrzny')}
                              >
                                Zapas napow.
                              </Button>
                            </div>
                          </div>
                        )}
                        <PhotoDropzone disabled={!selectedNode.acceptsPhotos || uploading} onFiles={handleFiles} />
                        
                        {selectedNode.acceptsPhotos && (
                          <div className="flex items-center justify-between">
                            <p className="text-sm text-muted-foreground">
                              Wymagane: {selectedNode.minPhotos} {selectedNode.minPhotos === 1 ? 'zdjęcie' : 'zdjęcia'}
                            </p>
                            
                            <div className="flex gap-2">
                              {selectedNode.status === 'NOT_APPLICABLE' ? (
                                <Button variant="outline" size="sm" onClick={async () => {
                                  await api.reopenNode(projectId, selectedNode.id);
                                  await refreshChecklist(selectedNode.id);
                                  await refreshNodeDetail(selectedNode.id);
                                }}>
                                  Przywróć wymóg
                                </Button>
                              ) : (
                                <Button variant="secondary" size="sm" onClick={async () => {
                                  await api.markNotApplicable(projectId, selectedNode.id, '');
                                  await refreshChecklist(selectedNode.id);
                                  await refreshNodeDetail(selectedNode.id);
                                }}>
                                  Zgłoś: Nie dotyczy
                                </Button>
                              )}
                            </div>
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="flex flex-col items-center justify-center py-20 text-center text-muted-foreground border-2 border-dashed border-border rounded-xl">
                        <ImagePlus size={48} className="mb-4 opacity-20" />
                        <h3 className="text-lg font-semibold text-foreground mb-1">Wybierz punkt z listy</h3>
                        <p className="text-sm">Aby dodać zdjęcia, najpierw wybierz odpowiedni punkt z drzewa checklisty po lewej stronie.</p>
                      </div>
                    )}
                  </div>

                  {/* Photos Grid Section */}
                  {nodeDetail && nodeDetail.photos.length > 0 && (
                    <div className="flex flex-col gap-4 pt-4 border-t border-border">
                      <div className="flex items-center justify-between">
                        <h3 className="font-semibold text-lg">Zarządzaj zdjęciami</h3>
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          onClick={() => setSelectedPhotoIds(allVisibleNodePhotosSelected ? new Set() : new Set(nodeDetail.photos.map(p => p.id)))}
                        >
                          <CheckCheck size={16} className="mr-2" />
                          {allVisibleNodePhotosSelected ? 'Odznacz wszystko' : 'Zaznacz wszystko'}
                        </Button>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {nodeDetail.photos.map((photo) => {
                          const isSelected = selectedPhotoIds.has(photo.id);
                          return (
                            <Card 
                              key={photo.id}
                              className={`overflow-hidden cursor-pointer transition-all border-2 ${isSelected ? 'border-primary ring-2 ring-primary/20' : 'border-transparent hover:border-border'}`}
                              onClick={() => togglePhotoSelection(photo.id)}
                            >
                              <div className="aspect-square bg-muted relative">
                                <img 
                                  src={api.photoThumbUrl(projectId, photo.id)} 
                                  alt={photo.storedFileName}
                                  className="w-full h-full object-cover" 
                                />
                                {isSelected && (
                                  <div className="absolute top-2 right-2 bg-primary text-primary-foreground rounded-full p-1">
                                    <Check size={14} />
                                  </div>
                                )}
                              </div>
                              <CardContent className="p-3 bg-card">
                                <p className="text-sm font-medium truncate" title={photo.storedFileName}>{photo.storedFileName}</p>
                                <div className="flex items-center justify-between mt-1 text-xs text-muted-foreground">
                                  <span>{formatBytes(photo.fileSize)}</span>
                                  <a 
                                    href={api.photoFileUrl(projectId, photo.id)} 
                                    target="_blank" 
                                    rel="noreferrer"
                                    className="text-primary hover:underline"
                                    onClick={e => e.stopPropagation()}
                                  >
                                    Otwórz
                                  </a>
                                </div>
                              </CardContent>
                            </Card>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </TabsContent>

            <TabsContent value="missing" className="flex-1 flex flex-col min-h-0 mt-0 data-[state=inactive]:hidden">
              <div className="flex-1 overflow-y-auto min-h-0">
                <div className="p-6 max-w-4xl mx-auto w-full">
                  <MissingPanel nodes={nodes} onSelect={handleNodeSelect} />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="ready" className="flex-1 flex flex-col min-h-0 mt-0 data-[state=inactive]:hidden">
              <div className="flex-1 overflow-y-auto min-h-0">
                <div className="p-6 max-w-5xl mx-auto w-full">
                  <ChatReviewPanel
                    projectId={projectId}
                    batches={chatBatches.filter((batch) => batch.status === 'READY_FOR_IMPORT')}
                    nodes={nodes}
                    onAccept={handleAcceptChatBatch}
                    onReject={handleRejectChatBatch}
                    emptyTitle="Brak paczek do importu"
                    emptyDescription="Paczki pewne po Qwenie trafia tutaj przed finalnym importem."
                    acceptLabel="Importuj"
                  />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="review" className="flex-1 flex flex-col min-h-0 mt-0 data-[state=inactive]:hidden">
              <div className="flex-1 overflow-y-auto min-h-0">
                <div className="p-6 max-w-5xl mx-auto w-full">
                  <ChatReviewPanel
                    projectId={projectId}
                    batches={chatBatches.filter((batch) => batch.status === 'PENDING_REVIEW')}
                    nodes={nodes}
                    onAccept={handleAcceptChatBatch}
                    onReject={handleRejectChatBatch}
                    acceptLabel="Importuj"
                  />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="import" className="flex-1 flex flex-col min-h-0 mt-0 data-[state=inactive]:hidden">
              <div className="flex-1 overflow-y-auto min-h-0">
                <div className="p-6 max-w-5xl mx-auto w-full">
                  <ChatImportPanel
                    projectId={projectId}
                    project={project}
                    batches={chatBatches}
                    onChanged={async () => {
                      await refreshChecklist(selectedNodeId);
                      await refreshNodeDetail(selectedNodeId);
                      await refreshChatBatches();
                    }}
                  />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="settings" className="flex-1 flex flex-col min-h-0 mt-0 data-[state=inactive]:hidden">
              <div className="flex-1 overflow-y-auto min-h-0">
                <div className="p-6 max-w-4xl mx-auto w-full flex flex-col gap-6">
                  <div>
                    <h3 className="text-lg font-bold">Wlasciwosci projektu</h3>
                    <p className="text-sm text-muted-foreground">
                      Dane bazowe projektu i bezpieczne przeliczanie checklisty z GPKG.
                    </p>
                  </div>

                  <Card>
                    <CardContent className="p-4 flex flex-col gap-4">
                      <div>
                        <h4 className="font-semibold">Nazwa projektu</h4>
                        <p className="text-sm text-muted-foreground">
                          Ta nazwa jest widoczna na liscie projektow i w naglowku zadania.
                        </p>
                      </div>
                      <div className="flex flex-col sm:flex-row gap-3">
                        <Input
                          value={draftName}
                          onChange={(event) => setDraftName(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void handleRename();
                          }}
                          placeholder="Nazwa projektu"
                        />
                        <Button
                          onClick={handleRename}
                          disabled={savingName || !draftName.trim() || draftName.trim() === project.name}
                          className="sm:w-36"
                        >
                          {savingName ? 'Zapisuje...' : 'Zapisz nazwe'}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardContent className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                      <div>
                        <p className="text-muted-foreground">Typ projektu</p>
                        <p className="font-medium">{project.projectType}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Topologia splitterow</p>
                        <p className="font-medium">
                          {project.splitterTopology} ({project.splitterTopologySource})
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">GPKG</p>
                        <p className="font-medium">{project.gpkgFileName}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Adresy / zapasy</p>
                        <p className="font-medium">
                          {project.addressCount} adresow, {project.dacToAddressCableCount} doziemnych,
                          {' '}
                          {project.adssToAddressCableCount} napowietrznych
                        </p>
                      </div>
                      <div className="md:col-span-2">
                        <p className="text-muted-foreground">Folder zdjec</p>
                        <p className="font-medium break-all">{project.baseFolder}</p>
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardContent className="p-4 flex flex-col gap-4">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <h4 className="font-semibold">Przelicz checklistę z GPKG</h4>
                          <p className="text-sm text-muted-foreground">
                            Operacja dopisuje nowe punkty, odswieza istniejace po sciezce i usuwa stare punkty
                            bez zdjec. Punkty ze zdjeciami zostaja zachowane jako nie dotyczy.
                          </p>
                        </div>
                        <RefreshCw size={18} className="text-muted-foreground mt-1 shrink-0" />
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-[1fr_220px] gap-3">
                        <Input
                          type="file"
                          accept=".gpkg"
                          onChange={(event) => setRecalculateFile(event.target.files?.[0] ?? null)}
                        />
                        <select
                          value={recalculateTopology}
                          onChange={(event) =>
                            setRecalculateTopology(event.target.value as 'AUTO' | 'SINGLE' | 'CASCADE')
                          }
                          className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                        >
                          <option value="AUTO">Topologia: auto</option>
                          <option value="SINGLE">Topologia: SINGLE</option>
                          <option value="CASCADE">Topologia: CASCADE</option>
                        </select>
                      </div>

                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm text-muted-foreground">
                          {recalculateFile ? recalculateFile.name : 'Wybierz plik GPKG do przeliczenia.'}
                        </p>
                        <Button
                          onClick={handleRecalculateChecklist}
                          disabled={!recalculateFile || recalculating}
                        >
                          {recalculating ? 'Przeliczam...' : 'Przelicz checklistę'}
                        </Button>
                      </div>

                      {recalculateResult && (
                        <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
                          {recalculateResult}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
