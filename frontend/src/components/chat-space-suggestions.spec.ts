import { describe, expect, it } from 'vitest';
import type { GoogleChatSpace, ProjectSummary } from '../types';
import { getSuggestedGoogleChatSpaces } from './chat-space-suggestions';

const project: ProjectSummary = {
  id: 'project-1',
  name: 'Q_KPO_1_OLSZ_e_BARTAG_MR_2_1_1_BARTĄG',
  projectDefinition: 'X/04017284',
  projectType: 'KPO',
  splitterTopology: 'SINGLE',
  splitterTopologySource: 'AUTO',
  splitterCount: 1,
  gpkgFileName: 'sample.gpkg',
  baseFolder: 'Z:\\BARTAG',
  addressCount: 0,
  dacToAddressCableCount: 0,
  adssToAddressCableCount: 0,
  progressDone: 0,
  progressTotal: 0,
  status: 'W trakcie',
  createdAt: '',
  updatedAt: '',
};

const spaces: GoogleChatSpace[] = [
  { name: 'spaces/OTHER', displayName: 'PURDA 02 X/04017460', spaceType: 'SPACE' },
  { name: 'spaces/BARTAG', displayName: 'BARTĄG X/04017287', spaceType: 'SPACE' },
  { name: 'spaces/MATCH', displayName: 'Bartag OPP03 X/04017284', spaceType: 'SPACE' },
];

describe('getSuggestedGoogleChatSpaces', () => {
  it('puts a room with matching project definition first', () => {
    const result = getSuggestedGoogleChatSpaces(project, spaces);

    expect(result[0]).toMatchObject({
      space: expect.objectContaining({ displayName: 'Bartag OPP03 X/04017284' }),
      isSuggested: true,
    });
  });

  it('matches Polish characters without requiring the exact spelling', () => {
    const result = getSuggestedGoogleChatSpaces(
      { ...project, projectDefinition: null },
      [
        { name: 'spaces/OTHER', displayName: 'PURDA 02 X/04017460', spaceType: 'SPACE' },
        { name: 'spaces/BARTAG', displayName: 'BARTĄG X/04017287', spaceType: 'SPACE' },
      ],
    );

    expect(result[0]).toMatchObject({
      space: expect.objectContaining({ displayName: 'BARTĄG X/04017287' }),
      isSuggested: true,
    });
  });
});
