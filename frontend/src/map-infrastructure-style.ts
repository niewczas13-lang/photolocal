import type { PathOptions } from 'leaflet';

import type { ProjectMapInfrastructureFeatureType } from './types';

export const INFRASTRUCTURE_MAP_PANE = 'project-map-infrastructure';
export const INFRASTRUCTURE_POPUP_PANE = 'popupPane';
export const INFRASTRUCTURE_PANE_STYLE = { zIndex: 250 };

export interface InfrastructurePointIconSpec {
  className: string;
  html: string;
  iconSize: [number, number];
  iconAnchor: [number, number];
  popupAnchor: [number, number];
}

function isEnergyOwner(owner: string | null | undefined): boolean {
  if (!owner) return false;
  const normalizedOwner = owner
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  if (normalizedOwner.includes('orange')) return false;
  return /\b(energa|enea|pge|tauron|e[- ]?on|innogy|energetycz|dystrybucj)\b/.test(normalizedOwner);
}

export function getInfrastructureLineStyle(): PathOptions {
  return {
    color: '#334155',
    dashArray: '4 7',
    opacity: 0.62,
    weight: 2,
  };
}

export function getInfrastructurePointIconSpec(
  featureType: ProjectMapInfrastructureFeatureType,
  owner?: string | null,
): InfrastructurePointIconSpec {
  if (featureType === 'pole') {
    const labelHtml = isEnergyOwner(owner)
      ? '<span class="project-map-infra-pole__label">E</span>'
      : '';
    return {
      className: 'project-map-infra-point-icon',
      html:
        '<span class="project-map-infra-pole">' +
        labelHtml +
        '<span class="project-map-infra-pole__stem"></span>' +
        '</span>',
      iconSize: [12, 20],
      iconAnchor: [6, 18],
      popupAnchor: [0, -18],
    };
  }

  return {
    className: 'project-map-infra-point-icon',
    html: '<span class="project-map-infra-manhole"></span>',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
    popupAnchor: [0, -8],
  };
}
