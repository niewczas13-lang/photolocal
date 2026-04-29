import { describe, expect, it } from 'vitest';
import { buildReservePhotoName, resolvePhotoTarget } from './photo-processor.js';

describe('photo processor naming', () => {
  it('names underground reserve photos by address and index', () => {
    expect(buildReservePhotoName('WRONCKIEJ_13', 3)).toBe('WRONCKIEJ_13_foto3.jpeg');
  });

  it('routes underground reserve photos into doziemne folder', () => {
    const target = resolvePhotoTarget({
      projectFolder: 'D:/Baza/PROJEKT',
      nodePath: 'Zapasy_kabli_instalacyjnych/OSD2640/WRONCKIEJ_13',
      nodeName: 'WRONCKIEJ_13',
      existingCount: 0,
      reserveLocation: 'Doziemny',
      sourceFileName: 'IMG_001.jpg',
    });

    expect(target.relativeFolder).toBe('Zapasy_kabli_instalacyjnych/doziemne/WRONCKIEJ_13');
    expect(target.fileName).toBe('WRONCKIEJ_13_foto1.jpeg');
  });
});
