export interface MapClickCaptureState {
  addingAddress: boolean;
  addingFreeNote: boolean;
  hasDraftNote: boolean;
}

export function isMapClickCaptureActive(state: MapClickCaptureState): boolean {
  return state.addingAddress || (state.addingFreeNote && !state.hasDraftNote);
}
