import { describe, expect, it } from 'vitest';

import { getMapBoundsPositions } from './map-bounds';
import type { ProjectMapData } from './types';

describe('map bounds', () => {
  it('does not include background infrastructure so toggling it does not move the viewport', () => {
    const data: ProjectMapData = {
      addresses: [
        {
          id: 'address-1',
          label: 'Testowa 1',
          city: 'Ostrzeszewo',
          street: 'Testowa',
          buildingNo: '1',
          distributionPoint: 'OSTRZESZEWO/OPP0002',
          lat: 53.75,
          lng: 20.55,
          reservePhotoCount: 0,
          hasReservePhoto: false,
          status: 'PENDING',
          isNotApplicable: false,
          isManuallyAdded: false,
          oplConsentConfirmed: false,
          photos: [],
        },
      ],
      addressCandidates: [],
      polygons: [],
      trunkCables: [],
      infraNodes: [],
      infrastructureFeatures: [
        {
          id: 'duct-1',
          featureType: 'duct',
          sourceLayer: 'Odcinki Kanalizacji',
          label: 'daleka kanalizacja',
          elementType: 'Kanalizacja pierwotna',
          owner: null,
          geojson: {
            type: 'LineString',
            coordinates: [
              [10, 40],
              [11, 41],
            ],
          },
        },
      ],
      notes: [],
    };

    expect(getMapBoundsPositions(data)).toEqual([[53.75, 20.55]]);
  });
});
