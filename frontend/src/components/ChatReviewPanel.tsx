import { useMemo, useState } from 'react';
import { Check, Images, Search, X } from 'lucide-react';
import { api } from '../api';
import type { ChatBatch, ChecklistNode } from '../types';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { Input } from './ui/input';

interface ChatReviewPanelProps {
  projectId: string;
  batches: ChatBatch[];
  nodes: ChecklistNode[];
  onAccept: (
    batchId: string,
    checklistNodeIds: string[],
    reserveLocation: 'Doziemny' | 'W studni' | null,
    fileIds: string[],
  ) => Promise<void>;
  onReject: (batchId: string) => Promise<void>;
  emptyTitle?: string;
  emptyDescription?: string;
  acceptLabel?: string;
}

interface CandidateNode {
  id: string;
  name: string;
  path: string;
  nodeType: ChecklistNode['nodeType'];
}

function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function collectAcceptingNodes(nodes: ChecklistNode[]): CandidateNode[] {
  return nodes.flatMap((node) => {
    const self =
      node.acceptsPhotos
        ? [{ id: node.id, name: node.name, path: node.path, nodeType: node.nodeType }]
        : [];
    return [...self, ...collectAcceptingNodes(node.children)];
  });
}

function scoreCandidate(batch: ChatBatch, candidate: CandidateNode): number {
  const source = normalize(`${batch.messageText} ${batch.folderName}`);
  const name = normalize(candidate.name);
  const parts = name.split(' ').filter(Boolean);
  const number = parts.at(-1) ?? '';
  const street = parts.slice(0, -1).join(' ');

  if (name && source.includes(name)) return 100;
  if (street && number && source.includes(street) && source.includes(number)) return 80;
  if (number && source.includes(number)) return 30;
  return 0;
}

export default function ChatReviewPanel({
  projectId,
  batches,
  nodes,
  onAccept,
  onReject,
  emptyTitle = 'Brak paczek do review',
  emptyDescription = 'Paczki z Google Chat pojawia sie tutaj po imporcie folderow.',
  acceptLabel = 'Importuj',
}: ChatReviewPanelProps) {
  const candidates = useMemo(() => collectAcceptingNodes(nodes), [nodes]);
  const [selectedByBatch, setSelectedByBatch] = useState<Record<string, Set<string>>>({});
  const [selectedFilesByBatch, setSelectedFilesByBatch] = useState<Record<string, Set<string>>>({});
  const [locationByBatch, setLocationByBatch] = useState<Record<string, 'Doziemny' | 'W studni'>>({});
  const [queryByBatch, setQueryByBatch] = useState<Record<string, string>>({});
  const [acceptingBatchId, setAcceptingBatchId] = useState<string | null>(null);
  const [rejectingBatchId, setRejectingBatchId] = useState<string | null>(null);

  const toggleCandidate = (batchId: string, nodeId: string, defaultNodeIds: string[] = []) => {
    setSelectedByBatch((current) => {
      const next = new Set(current[batchId] ?? defaultNodeIds);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return { ...current, [batchId]: next };
    });
  };

  const selectedNodeIdsForBatch = (batch: ChatBatch): Set<string> => {
    if (selectedByBatch[batch.id]) return selectedByBatch[batch.id];
    return batch.checklistNodeId ? new Set([batch.checklistNodeId]) : new Set<string>();
  };

  const selectedFileIdsForBatch = (batch: ChatBatch): string[] => {
    const selected = selectedFilesByBatch[batch.id];
    if (!selected) return batch.files.map((file) => file.id);
    return batch.files.filter((file) => selected.has(file.id)).map((file) => file.id);
  };

  const toggleFile = (batch: ChatBatch, fileId: string) => {
    setSelectedFilesByBatch((current) => {
      const next = new Set(current[batch.id] ?? batch.files.map((file) => file.id));
      if (next.has(fileId)) {
        next.delete(fileId);
      } else {
        next.add(fileId);
      }
      return { ...current, [batch.id]: next };
    });
  };

  const handleAccept = async (batchId: string) => {
    const batch = batches.find((candidate) => candidate.id === batchId);
    if (!batch) return;
    const selected = [...selectedNodeIdsForBatch(batch)];
    if (selected.length === 0) return;
    const fileIds = selectedFileIdsForBatch(batch);
    if (fileIds.length === 0) return;

    const requiresReserveLocation = selected.some((nodeId) => {
      const candidate = candidates.find((item) => item.id === nodeId);
      return candidate?.nodeType === 'CABLE_RESERVE';
    });

    setAcceptingBatchId(batchId);
    try {
      await onAccept(batchId, selected, requiresReserveLocation ? locationByBatch[batchId] ?? 'Doziemny' : null, fileIds);
    } finally {
      setAcceptingBatchId(null);
    }
  };

  const handleReject = async (batchId: string) => {
    setRejectingBatchId(batchId);
    try {
      await onReject(batchId);
    } finally {
      setRejectingBatchId(null);
    }
  };

  if (batches.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center text-muted-foreground border-2 border-dashed border-border rounded-xl">
        <Images size={44} className="mb-4 opacity-25" />
        <h3 className="text-lg font-semibold text-foreground mb-1">{emptyTitle}</h3>
        <p className="text-sm">{emptyDescription}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {batches.map((batch) => {
        const selected = selectedNodeIdsForBatch(batch);
        const selectedFileIds = selectedFileIdsForBatch(batch);
        const location = locationByBatch[batch.id] ?? batch.reserveLocation ?? 'Doziemny';
        const query = normalize(queryByBatch[batch.id] ?? '');
        const requiresReserveLocation = [...selected].some((nodeId) => {
          const candidate = candidates.find((item) => item.id === nodeId);
          return candidate?.nodeType === 'CABLE_RESERVE';
        });
        const suggested = candidates
          .map((candidate) => ({ candidate, score: scoreCandidate(batch, candidate) }))
          .filter(
            ({ candidate, score }) =>
              selected.has(candidate.id) ||
              score > 0 ||
              (query &&
                (normalize(candidate.name).includes(query) || normalize(candidate.path).includes(query))),
          )
          .sort((left, right) => right.score - left.score || left.candidate.name.localeCompare(right.candidate.name))
          .slice(0, query ? 40 : 12);

        return (
          <Card key={batch.id}>
            <CardContent className="p-4 flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-base font-semibold">{batch.folderName}</h3>
                    <p className="text-sm text-muted-foreground">{batch.messageText || 'Brak opisu'}</p>
                  </div>
                  <Badge variant={batch.status === 'PENDING_REVIEW' ? 'secondary' : 'default'}>
                    {batch.status}
                  </Badge>
                </div>
                {batch.reviewReason && <p className="text-sm text-amber-700">{batch.reviewReason}</p>}
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {batch.files.map((file) => {
                  const isSelected = selectedFileIds.includes(file.id);
                  return (
                    <div
                      key={file.id}
                      className={`relative aspect-square rounded-md overflow-hidden border bg-muted ${
                        isSelected ? 'ring-2 ring-primary' : 'opacity-45'
                      }`}
                    >
                      <a
                        href={api.chatBatchFileUrl(projectId, batch.id, file.id)}
                        target="_blank"
                        rel="noreferrer"
                        className="block h-full w-full"
                      >
                        <img
                          src={api.chatBatchFileUrl(projectId, batch.id, file.id)}
                          alt={file.fileName}
                          className="h-full w-full object-cover"
                        />
                      </a>
                      <label className="absolute left-2 top-2 flex items-center gap-2 rounded-md bg-background/90 px-2 py-1 text-xs font-medium shadow-sm">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleFile(batch, file.id)}
                        />
                        Import
                      </label>
                    </div>
                  );
                })}
              </div>

              <div className="grid md:grid-cols-[220px_1fr] gap-4">
                {requiresReserveLocation ? (
                <div className="flex flex-col gap-2">
                  <span className="text-sm font-semibold">Typ zapasu</span>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant={location === 'Doziemny' ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setLocationByBatch((current) => ({ ...current, [batch.id]: 'Doziemny' }))}
                    >
                      Doziemny
                    </Button>
                    <Button
                      variant={location === 'W studni' ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setLocationByBatch((current) => ({ ...current, [batch.id]: 'W studni' }))}
                    >
                      W studni
                    </Button>
                  </div>
                </div>
                ) : (
                  <div className="flex flex-col gap-1 text-sm text-muted-foreground">
                    <span className="font-semibold text-foreground">Typ zapasu</span>
                    <span>Wymagany tylko dla folderow zapasow.</span>
                  </div>
                )}

                <div className="flex flex-col gap-2 min-w-0">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-semibold">Folder checklisty</span>
                    <div className="relative w-64 max-w-full">
                      <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={queryByBatch[batch.id] ?? ''}
                        onChange={(event) =>
                          setQueryByBatch((current) => ({ ...current, [batch.id]: event.target.value }))
                        }
                        placeholder="Szukaj folderu"
                        className="h-8 pl-8 text-sm"
                      />
                    </div>
                  </div>

                  <div className="grid md:grid-cols-2 gap-2">
                    {suggested.map(({ candidate }) => (
                      <label
                        key={candidate.id}
                        className="flex items-start gap-2 rounded-md border p-2 text-sm cursor-pointer hover:bg-muted/50"
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(candidate.id)}
                          onChange={() =>
                            toggleCandidate(
                              batch.id,
                              candidate.id,
                              batch.checklistNodeId ? [batch.checklistNodeId] : [],
                            )
                          }
                          className="mt-1"
                        />
                        <span className="min-w-0">
                          <span className="flex items-center gap-2 min-w-0">
                            <span className="block font-medium truncate">{candidate.name}</span>
                            {candidate.nodeType === 'CABLE_RESERVE' && (
                              <Badge variant="secondary" className="shrink-0 text-[10px]">
                                zapas
                              </Badge>
                            )}
                          </span>
                          <span className="block text-xs text-muted-foreground truncate">{candidate.path}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>

              <div className="flex justify-end">
                <Button
                  variant="outline"
                  disabled={rejectingBatchId === batch.id || acceptingBatchId === batch.id}
                  onClick={() => void handleReject(batch.id)}
                  className="mr-2"
                >
                  <X size={16} className="mr-2" />
                  Odrzuc paczke
                </Button>
                <Button
                  disabled={selected.size === 0 || selectedFileIds.length === 0 || acceptingBatchId === batch.id}
                  onClick={() => void handleAccept(batch.id)}
                >
                  <Check size={16} className="mr-2" />
                  {acceptLabel} {selectedFileIds.length} zdjec do {selected.size || 0} folderow
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
