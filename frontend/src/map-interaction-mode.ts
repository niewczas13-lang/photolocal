export interface MapClickCaptureState {
  addingAddress: boolean;
  addingFreeNote: boolean;
  hasDraftNote: boolean;
}

export function isMapClickCaptureActive(state: MapClickCaptureState): boolean {
  return state.addingAddress || (state.addingFreeNote && !state.hasDraftNote);
}

export function getMapClickCaptureClassName(state: MapClickCaptureState): string | null {
  return isMapClickCaptureActive(state) ? 'project-map-leaflet--click-capture' : null;
}

type ClosestTarget = EventTarget & {
  closest: (selector: string) => Element | null;
};

function hasClosest(target: EventTarget | null): target is ClosestTarget {
  return typeof (target as { closest?: unknown } | null)?.closest === 'function';
}

export function shouldCaptureMapCanvasClick(target: EventTarget | null): boolean {
  if (!hasClosest(target)) return true;
  return !target.closest('.leaflet-control, .leaflet-popup');
}
