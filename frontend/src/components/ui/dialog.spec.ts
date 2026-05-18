import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('dialog layering', () => {
  it('keeps dialog overlay and content above Leaflet map panes', () => {
    const source = readFileSync(resolve(__dirname, 'dialog.tsx'), 'utf8');

    expect(source).toMatch(/data-slot="dialog-overlay"[\s\S]*z-\[2000\]/);
    expect(source).toMatch(/data-slot="dialog-content"[\s\S]*z-\[2010\]/);
  });
});
