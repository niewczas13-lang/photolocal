import type { ChecklistNode } from '../types';

export function isNodeComplete(node: ChecklistNode): boolean {
  if (node.status === 'NOT_APPLICABLE') return true;
  if (node.acceptsPhotos) return node.minPhotos > 0 && node.photoCount >= node.minPhotos;

  return node.children.length > 0 && node.children.every(isNodeComplete);
}
