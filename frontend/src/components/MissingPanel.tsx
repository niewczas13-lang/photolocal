import { useEffect, useMemo, useState } from 'react';
import { Search, AlertCircle } from 'lucide-react';
import type { ChecklistNode } from '../types';
import ChecklistTree from './ChecklistTree';
import { Input } from './ui/input';

interface MissingPanelProps {
  nodes: ChecklistNode[];
  onSelect: (node: ChecklistNode) => void;
}

export default function MissingPanel({ nodes, onSelect }: MissingPanelProps) {
  const [query, setQuery] = useState('');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const missingTree = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    const filterMissing = (items: ChecklistNode[]): ChecklistNode[] => {
      return items.flatMap((node) => {
        const children = filterMissing(node.children);
        const isMissing = node.acceptsPhotos && node.status === 'OPEN' && node.photoCount < node.minPhotos;
        if (isMissing || children.length > 0) {
          return [{ ...node, children }];
        }
        return [];
      });
    };

    const treeOnlyMissing = filterMissing(nodes);

    if (!normalizedQuery) return treeOnlyMissing;

    const filterByQuery = (items: ChecklistNode[]): ChecklistNode[] => {
      return items.flatMap((node) => {
        const children = filterByQuery(node.children);
        const isMatch =
          node.name.toLowerCase().includes(normalizedQuery) ||
          node.path.toLowerCase().includes(normalizedQuery);
        if (isMatch || children.length > 0) {
          return [{ ...node, children }];
        }
        return [];
      });
    };

    return filterByQuery(treeOnlyMissing);
  }, [nodes, query]);

  useEffect(() => {
    const allExpandableIds = new Set<string>();
    const collect = (items: ChecklistNode[]) => {
      for (const node of items) {
        if (node.children.length > 0) {
          allExpandableIds.add(node.id);
          collect(node.children);
        }
      }
    };
    collect(missingTree);
    setExpandedIds(allExpandableIds);
  }, [missingTree]);

  const handleToggle = (nodeId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
        <div>
          <h3 className="text-lg font-bold">Braki do uzupełnienia</h3>
          <p className="text-sm text-muted-foreground">Poniżej znajdziesz tylko te punkty, które wymagają jeszcze zdjęć.</p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Szukaj braków..."
            className="pl-9 h-9"
          />
        </div>
      </div>

      <div className="bg-muted/10 border border-border rounded-xl overflow-hidden">
        {missingTree.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground text-center">
            <AlertCircle size={40} className="mb-3 opacity-20" />
            <p className="text-lg font-medium text-foreground">Brak braków!</p>
            <p className="text-sm">Wszystkie punkty zostały uzupełnione.</p>
          </div>
        ) : (
          <div className="p-2">
            <ChecklistTree
              nodes={missingTree}
              selectedNodeId={null}
              expandedIds={expandedIds}
              onSelect={onSelect}
              onToggle={handleToggle}
            />
          </div>
        )}
      </div>
    </div>
  );
}
