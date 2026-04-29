import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { findChatManifests, readChatManifest } from './chat-manifest.js';

async function createTempFolder(): Promise<string> {
  const folder = join(tmpdir(), `photo-local-manifest-${randomUUID()}`);
  await mkdir(folder, { recursive: true });
  return folder;
}

describe('readChatManifest', () => {
  it('parses a valid Google Chat manifest', async () => {
    const folder = await createTempFolder();
    const manifestPath = join(folder, 'manifest.json');
    await writeFile(
      manifestPath,
      JSON.stringify({
        source: 'google-chat',
        spaceName: 'spaces/AAA',
        spaceDisplayName: 'Radom OPP13',
        messageName: 'spaces/AAA/messages/BBB',
        messageText: 'Maleniecka 19B',
        createTime: '2025-10-16T12:00:00Z',
        folderName: '2025-10-16_Maleniecka 19B',
        files: [
          {
            fileName: 'photo.jpeg',
            contentName: 'photo.jpeg',
            contentType: 'image/jpeg',
          },
        ],
      }),
      'utf-8',
    );

    await writeFile(join(folder, 'photo.jpeg'), 'not-a-real-image');

    await expect(readChatManifest(manifestPath)).resolves.toEqual({
      source: 'google-chat',
      spaceName: 'spaces/AAA',
      spaceDisplayName: 'Radom OPP13',
      messageName: 'spaces/AAA/messages/BBB',
      messageText: 'Maleniecka 19B',
      createTime: '2025-10-16T12:00:00Z',
      folderName: '2025-10-16_Maleniecka 19B',
      folderPath: folder,
      files: [
        {
          fileName: 'photo.jpeg',
          contentName: 'photo.jpeg',
          contentType: 'image/jpeg',
        },
      ],
    });
  });

  it('defaults optional text and files fields', async () => {
    const folder = await createTempFolder();
    const manifestPath = join(folder, 'manifest.json');
    await writeFile(
      manifestPath,
      JSON.stringify({
        source: 'google-chat',
        spaceName: 'spaces/AAA',
        spaceDisplayName: 'Radom OPP13',
        messageName: 'spaces/AAA/messages/BBB',
        createTime: '2025-10-16T12:00:00Z',
        folderName: '2025-10-16_brak_opisu',
      }),
      'utf-8',
    );

    const manifest = await readChatManifest(manifestPath);

    expect(manifest.messageText).toBe('');
    expect(manifest.files).toEqual([]);
  });

  it('filters unsupported file extensions', async () => {
    const folder = await createTempFolder();
    const manifestPath = join(folder, 'manifest.json');
    await writeFile(
      manifestPath,
      JSON.stringify({
        source: 'google-chat',
        spaceName: 'spaces/AAA',
        spaceDisplayName: 'Radom OPP13',
        messageName: 'spaces/AAA/messages/BBB',
        folderName: '2025-10-16_Maleniecka 19B',
        files: [
          { fileName: 'photo.jpeg', contentType: 'image/jpeg' },
          { fileName: 'notes.txt', contentType: 'text/plain' },
        ],
      }),
      'utf-8',
    );

    const manifest = await readChatManifest(manifestPath);

    expect(manifest.files.map((file) => file.fileName)).toEqual(['photo.jpeg']);
  });
});

describe('findChatManifests', () => {
  it('finds manifests recursively in stable order', async () => {
    const root = await createTempFolder();
    const first = join(root, '2025-10-16_Maleniecka 19B');
    const second = join(root, '2025-10-17_Maleniecka 20');
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });

    for (const folder of [second, first]) {
      await writeFile(
        join(folder, 'manifest.json'),
        JSON.stringify({
          source: 'google-chat',
          spaceName: 'spaces/AAA',
          spaceDisplayName: 'Radom OPP13',
          messageName: `spaces/AAA/messages/${folder}`,
          folderName: folder.split(/[\\/]/).at(-1),
          files: [],
        }),
        'utf-8',
      );
    }

    const manifests = await findChatManifests(root);

    expect(manifests.map((manifest) => manifest.folderName)).toEqual([
      '2025-10-16_Maleniecka 19B',
      '2025-10-17_Maleniecka 20',
    ]);
  });

  it('creates a legacy manifest from image folders without manifest.json', async () => {
    const root = await createTempFolder();
    const folder = join(root, 'Radom OPP13', '2025-10-17_Maleniecka 23 i 23A');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'photo.jpeg'), 'image');

    const manifests = await findChatManifests(root);

    expect(manifests).toEqual([
      expect.objectContaining({
        source: 'google-chat',
        folderName: '2025-10-17_Maleniecka 23 i 23A',
        messageText: 'Maleniecka 23 i 23A',
        files: [expect.objectContaining({ fileName: 'photo.jpeg' })],
      }),
    ]);
  });
});
