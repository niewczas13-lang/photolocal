import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import ProjectMapNotes from './ProjectMapNotes';

const noop = () => undefined;

function renderNotes(reportBusy: 'plain' | 'qwen' | null): string {
  return renderToStaticMarkup(
    <ProjectMapNotes
      notes={[]}
      busyId={null}
      reportBusy={reportBusy}
      onDownloadReport={noop}
      onUpdateNote={noop}
      onDeleteNote={noop}
      onUploadNotePhoto={noop}
      onShowOnMap={noop}
    />,
  );
}

describe('ProjectMapNotes report actions', () => {
  it('renders both idle report actions', () => {
    const markup = renderNotes(null);

    expect(markup).toContain('Eksport XLSX');
    expect(markup).toContain('Eksport + Qwen');
  });

  it('renders the Qwen busy label and disables both report actions', () => {
    const markup = renderNotes('qwen');

    expect(markup).toContain('Qwen pracuje...');
    expect(markup.match(/<button\b[^>]* disabled=""/g)).toHaveLength(2);
  });
});
