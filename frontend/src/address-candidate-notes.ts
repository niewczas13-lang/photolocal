import type { ProjectMapAddressCandidate, ProjectMapNoteTargetType } from './types';

export interface AddressCandidateNoteInput {
  targetType: ProjectMapNoteTargetType;
  targetId: string | null;
  targetLabel: string | null;
  body: string;
  lat: number | null;
  lng: number | null;
}

export function buildAddressCandidateNoteInput(
  candidate: ProjectMapAddressCandidate,
  body: string,
): AddressCandidateNoteInput | null {
  const trimmedBody = body.trim();
  if (!trimmedBody) return null;

  return {
    targetType: 'free',
    targetId: null,
    targetLabel: `Adres do dodania: ${candidate.label}`,
    body: trimmedBody,
    lat: candidate.lat,
    lng: candidate.lng,
  };
}
