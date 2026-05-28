import { describe, expect, it } from 'vitest';
import { getMapClickCaptureClassName, isMapClickCaptureActive } from './map-interaction-mode';

describe('isMapClickCaptureActive', () => {
  it('captures map clicks while adding an address even over interactive layers', () => {
    expect(
      isMapClickCaptureActive({
        addingAddress: true,
        addingFreeNote: false,
        hasDraftNote: false,
      }),
    ).toBe(true);
  });

  it('captures map clicks while picking a free note position', () => {
    expect(
      isMapClickCaptureActive({
        addingAddress: false,
        addingFreeNote: true,
        hasDraftNote: false,
      }),
    ).toBe(true);
  });

  it('allows normal layer popups outside click-picking modes', () => {
    expect(
      isMapClickCaptureActive({
        addingAddress: false,
        addingFreeNote: true,
        hasDraftNote: true,
      }),
    ).toBe(false);
  });
});

describe('getMapClickCaptureClassName', () => {
  it('adds a click-capture class while adding an address', () => {
    expect(
      getMapClickCaptureClassName({
        addingAddress: true,
        addingFreeNote: false,
        hasDraftNote: false,
      }),
    ).toBe('project-map-leaflet--click-capture');
  });

  it('does not add a click-capture class during normal map browsing', () => {
    expect(
      getMapClickCaptureClassName({
        addingAddress: false,
        addingFreeNote: false,
        hasDraftNote: false,
      }),
    ).toBeNull();
  });
});
