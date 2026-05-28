import { describe, expect, it } from 'vitest';

import { buildAddressCandidateNoteInput } from './address-candidate-notes';
import type { ProjectMapAddressCandidate } from './types';

const candidate: ProjectMapAddressCandidate = {
  id: 'candidate-1',
  label: 'UL_ZIOLOWA_1',
  status: 'PENDING',
  city: 'Bartag',
  street: 'Ziolowa',
  buildingNo: '1',
  postalCode: null,
  propertyId: 'dz-1',
  parcelNumber: '12/3',
  lat: 53.76778,
  lng: 20.5377,
  geocoderSource: 'PRG',
  geocoderDistanceMeters: 2.4,
  suggestedDistributionPoint: 'BARTAG/OPP0049',
  assignmentSource: 'REGION',
  approvedAddressId: null,
  reserveLocation: null,
  createdAt: '2026-05-28T09:00:00Z',
  updatedAt: '2026-05-28T09:00:00Z',
};

describe('buildAddressCandidateNoteInput', () => {
  it('creates a free map note at the candidate position', () => {
    expect(buildAddressCandidateNoteInput(candidate, '  sprawdzic przylacze  ')).toEqual({
      targetType: 'free',
      targetId: null,
      targetLabel: 'Adres do dodania: UL_ZIOLOWA_1',
      body: 'sprawdzic przylacze',
      lat: 53.76778,
      lng: 20.5377,
    });
  });

  it('does not create a note for empty body', () => {
    expect(buildAddressCandidateNoteInput(candidate, '   ')).toBeNull();
  });
});
