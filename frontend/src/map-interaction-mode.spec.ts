import { describe, expect, it } from 'vitest';
import { isMapClickCaptureActive } from './map-interaction-mode';

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
