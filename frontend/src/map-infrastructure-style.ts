import type { PathOptions } from 'leaflet';

import type { ProjectMapInfrastructureFeatureType } from './types';

export const INFRASTRUCTURE_MAP_PANE = 'project-map-infrastructure';
export const INFRASTRUCTURE_PANE_STYLE = { zIndex: 250 };

export interface InfrastructurePointIconSpec {
  className: string;
  html: string;
  iconSize: [number, number];
  iconAnchor: [number, number];
  popupAnchor: [number, number];
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
): InfrastructurePointIconSpec {
  if (featureType === 'pole') {
    return {
      className: 'project-map-infra-point-icon',
      html:
        '<span class="project-map-infra-pole">' +
        '<span class="project-map-infra-pole__label">E</span>' +
        '<span class="project-map-infra-pole__stem"></span>' +
        '</span>',
      iconSize: [18, 26],
      iconAnchor: [9, 22],
      popupAnchor: [0, -22],
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
