import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('select layering', () => {
  it('keeps select popups above dialogs rendered over the map', () => {
    const source = readFileSync(resolve(__dirname, 'select.tsx'), 'utf8');

    expect(source).toMatch(/SelectPrimitive\.Positioner[\s\S]*z-\[2020\]/);
    expect(source).toMatch(/data-slot="select-content"[\s\S]*z-\[2020\]/);
  });
});
