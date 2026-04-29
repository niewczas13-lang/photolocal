import { Camera, ChevronDown, ChevronRight, FolderClosed, FolderOpen, HardDrive, CheckCircle2, CircleDashed } from 'lucide-react';
import type { ChecklistNode } from '../types';
import { isNodeComplete } from './checklist-completion';

interface ChecklistTreeProps {
  nodes: ChecklistNode[];
  selectedNodeId: string | null;
  expandedIds: Set<string>;
  onSelect: (node: ChecklistNode) => void;
  onToggle: (nodeId: string) => void;
  level?: number;
}

function nodeIcon(node: ChecklistNode, isExpanded: boolean, isComplete: boolean) {
  if (!node.acceptsPhotos) {
    if (isComplete) {
      return isExpanded ? <FolderOpen size={16} className="text-green-600" /> : <FolderClosed size={16} className="text-green-600" />;
    }
    return isExpanded ? <FolderOpen size={16} className="text-primary" /> : <FolderClosed size={16} className="text-muted-foreground" />;
  }

  if (node.nodeType === 'DISTRIBUTION') {
    return <HardDrive size={16} className="text-amber-500" />;
  }

  return <Camera size={16} className="text-teal-500" />;
}

export default function ChecklistTree({
  nodes,
  selectedNodeId,
  expandedIds,
  onSelect,
  onToggle,
  level = 0,
}: ChecklistTreeProps) {
  return (
    <ul className="m-0 p-0 list-none">
      {nodes.map((node) => {
        const isExpanded = expandedIds.has(node.id);
        const hasChildren = node.children.length > 0;
        const isSelected = node.id === selectedNodeId;

        // Status logic
        const isComplete = isNodeComplete(node);
        const isFolderComplete = !node.acceptsPhotos && hasChildren && isComplete;
        const hasPhotos = node.photoCount > 0;
        const isNotApplicable = node.status === 'NOT_APPLICABLE';

        return (
          <li key={node.id}>
            <button
              type="button"
              onClick={() => {
                // One click logic:
                // If it accepts photos, select it
                // If it doesn't (it's a folder), toggle it
                // If it accepts photos AND has children (rare but possible), we might want to do both or prioritize select. Let's select it and expand it if not expanded.
                if (node.acceptsPhotos) {
                  onSelect(node);
                  if (hasChildren && !isExpanded) onToggle(node.id);
                } else {
                  if (hasChildren) onToggle(node.id);
                }
              }}
              className={`w-full text-left flex items-center justify-between border-b border-border/40 transition-colors py-2 pr-4 ${isSelected ? 'bg-primary/10' : isFolderComplete ? 'bg-green-500/10 hover:bg-green-500/15' : 'hover:bg-muted/50'} ${isNotApplicable ? 'opacity-40 grayscale' : ''}`}
              style={{ paddingLeft: `${12 + level * 16}px` }}
            >
              <div className="flex items-center gap-2 overflow-hidden">
                {hasChildren ? (
                  <div className="w-5 flex items-center justify-center text-muted-foreground">
                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </div>
                ) : (
                  <div className="w-5" />
                )}
                
                <div className="flex items-center gap-2">
                  <div className="flex items-center justify-center w-5">
                    {nodeIcon(node, isExpanded, isComplete)}
                  </div>
                  <span className={`text-sm truncate ${isSelected ? 'font-semibold text-primary' : isFolderComplete ? 'font-semibold text-green-700' : 'text-foreground/90'} ${isNotApplicable ? 'line-through' : ''}`}>
                    {node.name}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-3 shrink-0 ml-2">
                {isFolderComplete && (
                  <CheckCircle2 size={14} className="text-green-600" />
                )}
                {node.acceptsPhotos && (
                  <>
                    {isNotApplicable ? (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                        N/D
                      </span>
                    ) : (
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${isComplete ? 'bg-green-500/20 text-green-500' : hasPhotos ? 'bg-amber-500/20 text-amber-500' : 'bg-muted text-muted-foreground'}`}>
                        {node.photoCount}/{node.minPhotos}
                      </span>
                    )}
                    
                    {isNotApplicable ? (
                       <div className="w-[14px]" />
                    ) : isComplete ? (
                      <CheckCircle2 size={14} className="text-green-500" />
                    ) : hasPhotos ? (
                      <CircleDashed size={14} className="text-amber-500 animate-pulse" />
                    ) : (
                      <CircleDashed size={14} className="text-muted-foreground/50" />
                    )}
                  </>
                )}
              </div>
            </button>
            
            {hasChildren && isExpanded && (
              <ChecklistTree
                nodes={node.children}
                selectedNodeId={selectedNodeId}
                expandedIds={expandedIds}
                onSelect={onSelect}
                onToggle={onToggle}
                level={level + 1}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
