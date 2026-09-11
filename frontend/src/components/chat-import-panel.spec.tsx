import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChatBatch, ProjectSummary } from '../types';
import ChatImportPanel from './ChatImportPanel';

const project: ProjectSummary = {
  id: 'project-1',
  name: 'Projekt z istniejącą kolejką',
  projectDefinition: null,
  projectType: 'KPO',
  splitterTopology: 'SINGLE',
  splitterTopologySource: 'AUTO',
  splitterCount: 1,
  gpkgFileName: 'project.gpkg',
  baseFolder: '/data/project-1',
  googleChatSpaceName: null,
  googleChatSpaceDisplayName: null,
  googleChatLastDownloadAt: null,
  addressCount: 0,
  dacToAddressCableCount: 0,
  adssToAddressCableCount: 0,
  progressDone: 0,
  progressTotal: 0,
  status: 'W trakcie',
  createdAt: '',
  updatedAt: '',
};

const waitingBatch: ChatBatch = {
  id: 'batch-1',
  projectId: project.id,
  source: 'google-chat',
  sourceSpaceName: 'spaces/old-room',
  sourceSpaceDisplayName: 'Poprzedni pokój',
  sourceMessageName: 'spaces/old-room/messages/1',
  messageText: 'Zdjęcia z budowy',
  sourceCreateTime: '',
  sourceMessages: [],
  folderName: 'batch-1',
  folderPath: '/data/chat/batch-1',
  status: 'WAITING_FOR_CLASSIFICATION',
  reviewReason: null,
  checklistNodeId: null,
  reserveLocation: null,
  confidence: null,
  llmModel: null,
  llmRawResponse: null,
  visualEvidence: [],
  fileCount: 1,
  files: [],
  createdAt: '',
  updatedAt: '',
};

describe('standalone Qwen classification', () => {
  it('allows existing queued batches without a Google connection or download snapshot', () => {
    const markup = renderToStaticMarkup(<ChatImportPanel
      projectId={project.id}
      project={project}
      batches={[waitingBatch]}
      onChanged={async () => {}}
    />);
    const button = markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)
      ?.find((element) => element.includes('Weryfikuj Qwen'));

    expect(button).toBeDefined();
    expect(button).not.toContain('disabled=""');
    expect(button).not.toContain('aria-disabled="true"');
  });
});

describe('Google Chat room selection', () => {
  it('allows opening room selection without starting a job or requiring a Google session', () => {
    const markup = renderToStaticMarkup(<ChatImportPanel
      projectId={project.id}
      project={{ ...project, googleChatSpaceName: 'spaces/old-room' }}
      batches={[waitingBatch]}
      onChanged={async () => {}}
    />);
    const button = markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)
      ?.find((element) => element.includes('Zmien pokoj'));

    expect(button).toBeDefined();
    expect(button).not.toContain('disabled=""');
    expect(button).not.toContain('aria-disabled="true"');
  });
});
