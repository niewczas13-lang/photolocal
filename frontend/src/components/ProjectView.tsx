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
  ClipboardCheck
} from 'lucide-react';
import { api } from '../api';
import type { ChatBatch, ChecklistNode, ChecklistNodeDetail, ChecklistPhoto, ProjectSummary } from '../types';
import ChatImportPanel from './ChatImportPanel';
import ChatReviewPanel from './ChatReviewPanel';
import ChecklistTree from './ChecklistTree';
import MissingPanel from './MissingPanel';
import PhotoDropzone from './PhotoDropzone';

import { Button } from './ui/button';
import { Input } from './ui/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import { Badge } from './ui/badge';
import { Card, CardContent } from './ui/card';

interface ProjectViewProps {
  project: ProjectSummary;
  onBack: () => void;
  onRename: (newName: string) => void;
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

export default function ProjectView({ project, onBack, onRename }: ProjectViewProps) {
  const projectId = project.id;
  const [nodes, setNodes] = useState<ChecklistNode[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [nodeDetail, setNodeDetail] = useState<ChecklistNodeDetail | null>(null);
  const [reserveLocation, setReserveLocation] = useState<'Doziemny' | 'W studni'>('Doziemny');
  const [uploading, setUploading] = useState(false);
  const [search, setSearch] = useState('');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<Set<string>>(new Set());
  const [movingPhotos, setMovingPhotos] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(project.name);
  const [activeTab, setActiveTab] = useState<'photos' | 'missing' | 'import' | 'ready' | 'review'>('photos');
  const [chatBatches, setChatBatches] = useState<ChatBatch[]>([]);

  const handleRename = async () => {
    if (!draftName.trim() || draftName.trim() === project.name) {
      setEditingName(false);
      setDraftName(project.name);
      return;
    }
    try {
      await api.renameProject(projectId, draftName.trim());
      onRename(draftName.trim());
      setEditingName(false);
    } catch (err) {
      console.error(err);
      alert('Blad podczas zmiany nazwy');
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
    void refreshNodeDetail(selectedNodeId);
  }, [projectId, selectedNodeId]);

  const { filtered, autoExpandedIds } = useMemo(() => filterTree(nodes, search), [nodes, search]);
  const renderedExpandedIds = useMemo(
    () => new Set([...expandedIds, ...autoExpandedIds]),
    [expandedIds, autoExpandedIds],
  );
  const missingCount = useMemo(() => collectMissingNodes(nodes).length, [nodes]);

  const handleNodeSelect = (node: ChecklistNode) => {
    setSelectedNodeId(node.id);
    const ancestors = collectAncestorIds(nodes, node.id) ?? [];
    setExpandedIds((current) => new Set([...current, ...ancestors]));
    setActiveTab('photos');
  };

  const handleAcceptChatBatch = async (
    batchId: string,
    checklistNodeIds: string[],
    nextReserveLocation: 'Doziemny' | 'W studni' | null,
    fileIds: string[],
  ) => {
    try {
      await api.acceptChatBatch(projectId, batchId, checklistNodeIds, nextReserveLocation, fileIds);
      await refreshChecklist(selectedNodeId);
      await refreshNodeDetail(selectedNodeId);
      await refreshChatBatches();
    } catch (err) {
      console.error(err);
      alert('Blad podczas akceptacji paczki z czatu');
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
      const location = selectedNode.path.startsWith('Zapasy_kabli_instalacyjnych')
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

  const handleBulkMove = async (nextLocation: 'Doziemny' | 'W studni') => {
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
          <Button variant="ghost" size="icon" onClick={onBack}>
            <ArrowLeft size={18} />
          </Button>
          <div>
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
                <Button size="icon" variant="ghost" onClick={handleRename} className="h-8 w-8 text-green-500 hover:text-green-600">
                  <Check size={16} />
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2 group">
                <h2 className="text-xl font-bold tracking-tight">{project.name}</h2>
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
      </div>

      {/* Main Content Area */}
      <div className="flex flex-1 overflow-hidden">
        
        {/* Left Column - Checklist */}
        <div className="w-80 md:w-96 border-r border-border flex flex-col bg-muted/10 shrink-0">
          <div className="p-4 flex flex-col gap-3 shrink-0">
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
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'photos' | 'missing' | 'import' | 'ready' | 'review')} className="flex-1 flex flex-col min-h-0">
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
                        
                        {selectedNode.path.startsWith('Zapasy_kabli_instalacyjnych') && (
                          <div className="flex flex-col gap-2 p-4 bg-muted/30 border border-border rounded-lg mb-2">
                            <span className="text-sm font-semibold">Wybierz rodzaj zapasu przed wgraniem zdjęcia:</span>
                            <div className="flex gap-2">
                              <Button
                                variant={reserveLocation === 'Doziemny' ? 'default' : 'outline'}
                                size="sm"
                                onClick={() => setReserveLocation('Doziemny')}
                                className="flex-1"
                              >
                                Zapas doziemny
                              </Button>
                              <Button
                                variant={reserveLocation === 'W studni' ? 'default' : 'outline'}
                                size="sm"
                                onClick={() => setReserveLocation('W studni')}
                                className="flex-1"
                              >
                                Zapas w studni
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
          </Tabs>
        </div>
      </div>
    </div>
  );
}
