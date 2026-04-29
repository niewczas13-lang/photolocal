import { describe, expect, it } from 'vitest';
import type { ChecklistNode } from '../types';
import { isNodeComplete } from './checklist-completion';

function node(input: Partial<ChecklistNode>): ChecklistNode {
  return {
    id: input.id ?? 'node',
    name: input.name ?? 'Node',
    path: input.path ?? 'Node',
    nodeType: input.nodeType ?? 'STATIC',
    acceptsPhotos: input.acceptsPhotos ?? false,
    minPhotos: input.minPhotos ?? 0,
    photoCount: input.photoCount ?? 0,
    status: input.status ?? 'OPEN',
    children: input.children ?? [],
  };
}

describe('isNodeComplete', () => {
  it('marks a folder complete when every child requirement is complete', () => {
    const folder = node({
      children: [
        node({ acceptsPhotos: true, minPhotos: 1, photoCount: 1 }),
        node({ acceptsPhotos: true, minPhotos: 2, photoCount: 2 }),
      ],
    });

    expect(isNodeComplete(folder)).toBe(true);
  });

  it('does not mark a folder complete when any child is missing photos', () => {
    const folder = node({
      children: [
        node({ acceptsPhotos: true, minPhotos: 1, photoCount: 1 }),
        node({ acceptsPhotos: true, minPhotos: 2, photoCount: 1 }),
      ],
    });

    expect(isNodeComplete(folder)).toBe(false);
  });

  it('treats not applicable children as complete', () => {
    const folder = node({
      children: [
        node({ acceptsPhotos: true, minPhotos: 1, photoCount: 1 }),
        node({ acceptsPhotos: true, minPhotos: 2, photoCount: 0, status: 'NOT_APPLICABLE' }),
      ],
    });

    expect(isNodeComplete(folder)).toBe(true);
  });
});
