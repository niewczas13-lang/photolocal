import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveProjectPhotoFolder } from './project-photo-path.js';

describe('resolveProjectPhotoFolder', () => {
  it('creates a fixed zdjecia folder inside the selected task folder', () => {
    const selectedFolder = join('D:', 'projekty', 'opp13', 'pw', 'sap');

    expect(resolveProjectPhotoFolder(selectedFolder)).toBe(join(selectedFolder, 'zdjecia'));
  });

  it('rejects an empty selected task folder', () => {
    expect(() => resolveProjectPhotoFolder('   ')).toThrow('photoRootPath is required');
  });
});
