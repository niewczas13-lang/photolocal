import { useMemo, useState } from 'react';
import { Check, Home, MapPin, Trash2 } from 'lucide-react';

import type {
  ProjectMapAddressCandidate,
  ProjectMapCandidateReserveLocation,
  ProjectMapData,
} from '../types';
import { Button } from './ui/button';
import { Input } from './ui/input';

type AssignmentMode = 'auto' | 'existing' | 'manual';

interface ApproveAddressCandidateInput {
  city: string;
  street: string;
  buildingNo: string | null;
  propertyId: string | null;
  parcelNumber: string | null;
  distributionPoint: string | null;
  reserveLocation: ProjectMapCandidateReserveLocation;
  createDistributionNodeType: 'OSD' | 'OPP' | null;
  oplConsentConfirmed: boolean;
  noteBody: string | null;
}

interface ProjectMapAddressCandidatesProps {
  data: ProjectMapData;
  busyId: string | null;
  onApproveCandidate: (candidateId: string, input: ApproveAddressCandidateInput) => void;
  onRejectCandidate: (candidateId: string) => void;
}

function formatDistance(value: number | null): string {
  if (value == null) return 'brak dystansu';
  if (value < 10) return `${value.toFixed(1)} m`;
  return `${Math.round(value)} m`;
}

function CandidateCard({
  candidate,
  distributionPoints,
  busy,
  onApprove,
  onReject,
}: {
  candidate: ProjectMapAddressCandidate;
  distributionPoints: string[];
  busy: boolean;
  onApprove: (candidateId: string, input: ApproveAddressCandidateInput) => void;
  onReject: (candidateId: string) => void;
}) {
  const initialMode: AssignmentMode = candidate.suggestedDistributionPoint
    ? 'auto'
    : distributionPoints.length > 0
      ? 'existing'
      : 'manual';
  const [city, setCity] = useState(candidate.city);
  const [street, setStreet] = useState(candidate.street);
  const [buildingNo, setBuildingNo] = useState(candidate.buildingNo ?? '');
  const [assignmentMode, setAssignmentMode] = useState<AssignmentMode>(initialMode);
  const [selectedDistributionPoint, setSelectedDistributionPoint] = useState(distributionPoints[0] ?? '');
  const [manualDistributionPoint, setManualDistributionPoint] = useState('');
  const [manualDistributionNodeType, setManualDistributionNodeType] = useState<'OSD' | 'OPP'>('OSD');
  const [reserveLocation, setReserveLocation] = useState<ProjectMapCandidateReserveLocation>('Doziemny');
  const [oplConsentConfirmed, setOplConsentConfirmed] = useState(false);
  const [noteBody, setNoteBody] = useState('');

  const distributionPoint =
    assignmentMode === 'auto'
      ? candidate.suggestedDistributionPoint
      : assignmentMode === 'existing'
        ? selectedDistributionPoint
        : manualDistributionPoint;
  const canApprove = city.trim() !== '' && street.trim() !== '' && Boolean(distributionPoint?.trim());

  return (
    <article className="project-map-candidate-card">
      <div className="project-map-candidate-card__header">
        <span className="project-map-candidate-card__icon">
          <Home size={17} />
        </span>
        <div className="min-w-0">
          <h3>{candidate.label}</h3>
          <p>
            {candidate.geocoderSource} · {formatDistance(candidate.geocoderDistanceMeters)}
          </p>
        </div>
      </div>

      <div className="project-map-candidate-card__grid">
        <label>
          Miejscowosc
          <Input value={city} onChange={(event) => setCity(event.target.value)} />
        </label>
        <label>
          Ulica
          <Input value={street} onChange={(event) => setStreet(event.target.value)} />
        </label>
        <label>
          Numer
          <Input value={buildingNo} onChange={(event) => setBuildingNo(event.target.value)} />
        </label>
        <label>
          Typ zapasu
          <select
            value={reserveLocation}
            onChange={(event) => setReserveLocation(event.target.value as ProjectMapCandidateReserveLocation)}
          >
            <option value="Doziemny">Doziemny</option>
            <option value="Napowietrzny">Napowietrzny</option>
          </select>
        </label>
      </div>

      <div className="project-map-candidate-card__assignment">
        {candidate.suggestedDistributionPoint && (
          <label>
            <input
              type="radio"
              name={`assignment-${candidate.id}`}
              checked={assignmentMode === 'auto'}
              onChange={() => setAssignmentMode('auto')}
            />
            Rejonizacja: {candidate.suggestedDistributionPoint}
          </label>
        )}
        {distributionPoints.length > 0 && (
          <label>
            <input
              type="radio"
              name={`assignment-${candidate.id}`}
              checked={assignmentMode === 'existing'}
              onChange={() => setAssignmentMode('existing')}
            />
            <span>Wybierz OPP/OSD</span>
            <select
              value={selectedDistributionPoint}
              onChange={(event) => setSelectedDistributionPoint(event.target.value)}
              disabled={assignmentMode !== 'existing'}
            >
              {distributionPoints.map((point) => (
                <option key={point} value={point}>
                  {point}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          <input
            type="radio"
            name={`assignment-${candidate.id}`}
            checked={assignmentMode === 'manual'}
            onChange={() => setAssignmentMode('manual')}
          />
          <span>Nowy OPP/OSD</span>
          <select
            value={manualDistributionNodeType}
            onChange={(event) => setManualDistributionNodeType(event.target.value as 'OSD' | 'OPP')}
            disabled={assignmentMode !== 'manual'}
          >
            <option value="OSD">OSD</option>
            <option value="OPP">OPP</option>
          </select>
          <Input
            value={manualDistributionPoint}
            onChange={(event) => setManualDistributionPoint(event.target.value)}
            placeholder="np. OSTRZESZEWO/OSD0003"
            disabled={assignmentMode !== 'manual'}
          />
        </label>
      </div>

      <div className="project-map-candidate-card__coords">
        <MapPin size={13} />
        {candidate.lat.toFixed(6)}, {candidate.lng.toFixed(6)}
      </div>

      <label className="project-map-candidate-card__consent">
        <input
          type="checkbox"
          checked={oplConsentConfirmed}
          disabled={busy}
          onChange={(event) => setOplConsentConfirmed(event.currentTarget.checked)}
        />
        <span>Zgoda OPL</span>
      </label>

      <div className="project-map-candidate-card__note">
        <label>
          Notatka do adresu po zatwierdzeniu
          <textarea
            value={noteBody}
            rows={3}
            placeholder="Np. brak slupa, sprawdzic numer, klient nieobecny..."
            disabled={busy}
            onChange={(event) => setNoteBody(event.target.value)}
          />
        </label>
      </div>

      <div className="project-map-candidate-card__actions">
        <Button
          type="button"
          size="sm"
          disabled={busy || !canApprove}
          onClick={() =>
            onApprove(candidate.id, {
              city: city.trim(),
              street: street.trim(),
              buildingNo: buildingNo.trim() || null,
              propertyId: candidate.propertyId,
              parcelNumber: candidate.parcelNumber,
              distributionPoint: distributionPoint?.trim() || null,
              reserveLocation,
              createDistributionNodeType: assignmentMode === 'manual' ? manualDistributionNodeType : null,
              oplConsentConfirmed,
              noteBody: noteBody.trim() || null,
            })
          }
        >
          <Check size={14} />
          Zatwierdz
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onReject(candidate.id)}>
          <Trash2 size={14} />
          Odrzuc
        </Button>
      </div>
    </article>
  );
}

export default function ProjectMapAddressCandidates({
  data,
  busyId,
  onApproveCandidate,
  onRejectCandidate,
}: ProjectMapAddressCandidatesProps) {
  const distributionPoints = useMemo(
    () =>
      Array.from(
        new Set(
          data.infraNodes
            .filter((node) => node.nodeType === 'OSD' || node.nodeType === 'OPP')
            .map((node) => node.label ?? node.name)
            .filter(Boolean),
        ),
      ).sort((left, right) => left.localeCompare(right)),
    [data.infraNodes],
  );

  return (
    <div className="project-map-candidates">
      <div className="project-map-candidates__header">
        <div>
          <h2>Adresy do dodania</h2>
          <p>{data.addressCandidates.length} oczekujacych punktow z mapy</p>
        </div>
      </div>

      <div className="project-map-candidates__list">
        {data.addressCandidates.map((candidate) => (
          <CandidateCard
            key={candidate.id}
            candidate={candidate}
            distributionPoints={distributionPoints}
            busy={busyId === candidate.id}
            onApprove={onApproveCandidate}
            onReject={onRejectCandidate}
          />
        ))}
        {data.addressCandidates.length === 0 && (
          <div className="project-map-candidates__empty">Nie ma adresow oczekujacych na zatwierdzenie.</div>
        )}
      </div>
    </div>
  );
}
