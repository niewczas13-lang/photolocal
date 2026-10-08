import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSharedFolder,
  listSharedFolderChildren,
  listSharedFolderRoots,
} from './shared-folder-browser.js';

const { discoverDrives } = vi.hoisted(() => ({ discoverDrives: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: discoverDrives }),
  };
});

describe('configured shared folders', () => {
  let directory: string;
  let root: string;
  let outside: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'photo-local-shared-'));
    root = join(directory, 'photos');
    outside = join(directory, 'private');
    await mkdir(root);
    await mkdir(outside);
    vi.stubEnv('PHOTO_LOCAL_SHARED_ROOTS', JSON.stringify([{ path: root, label: 'Zdjęcia' }]));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it('exposes only configured roots with optional labels', async () => {
    expect(await listSharedFolderRoots()).toEqual([
      { path: root, label: 'Zdjęcia', providerName: null },
    ]);
    vi.stubEnv('PHOTO_LOCAL_SHARED_ROOTS', JSON.stringify([{ path: outside }]));
    expect(await listSharedFolderRoots()).toEqual([
      { path: outside, label: 'private', providerName: null },
    ]);
  });

  it.skipIf(process.platform !== 'win32')('keeps mapped-drive navigation working after canonicalization', async () => {
    vi.stubEnv('PHOTO_LOCAL_SHARED_ROOTS', undefined);
    const mappedPath = join(directory, 'mapped-drive');
    await symlink(root, mappedPath, 'junction');
    await mkdir(join(root, 'child'));
    discoverDrives.mockResolvedValue({ stdout: JSON.stringify({ DeviceID: mappedPath }) });
    const mappedRoot = (await listSharedFolderRoots())[0].path;
    const listed = await listSharedFolderChildren(mappedRoot);
    expect(listed.currentPath).toBe(root);
    expect((await listSharedFolderChildren(listed.entries[0].path)).parentPath).toBe(root);
  });

  it('treats an empty configured list as no permitted roots', async () => {
    vi.stubEnv('PHOTO_LOCAL_SHARED_ROOTS', '[]');
    expect(await listSharedFolderRoots()).toEqual([]);
    await expect(listSharedFolderChildren(root)).rejects.toThrow(/udostepnion/);
  });

  it.each(['{', '{}', '[null]', '[{"path":"relative"}]', '[{"path":42}]']) (
    'rejects invalid configuration %s',
    async (value) => {
      vi.stubEnv('PHOTO_LOCAL_SHARED_ROOTS', value);
      await expect(listSharedFolderRoots()).rejects.toThrow(/PHOTO_LOCAL_SHARED_ROOTS/);
    },
  );

  it('lists directories, permits dot-prefixed names, and stops navigation at the root', async () => {
    await mkdir(join(root, '..draft'));
    await writeFile(join(root, 'ignored.txt'), 'file');
    expect(await listSharedFolderChildren(root)).toEqual({
      currentPath: root,
      parentPath: null,
      entries: [{ name: '..draft', path: join(root, '..draft') }],
    });
    expect((await listSharedFolderChildren(join(root, '..draft'))).parentPath).toBe(root);
  });

  it('rejects outside siblings and lexical traversal', async () => {
    await expect(listSharedFolderChildren(outside)).rejects.toThrow(/udostepnion/);
    await expect(createSharedFolder(join(root, '..', 'private'), 'new')).rejects.toThrow(
      /udostepnion/,
    );
  });

  it('does not list or traverse a symlink outside its permitted root', async () => {
    await symlink(outside, join(root, 'escape'), 'junction');
    expect((await listSharedFolderChildren(root)).entries).toEqual([]);
    await expect(listSharedFolderChildren(join(root, 'escape'))).rejects.toThrow(/udostepnion/);
    await expect(createSharedFolder(join(root, 'escape'), 'new')).rejects.toThrow(/udostepnion/);
  });

  it('creates a folder inside a canonical parent and cannot overwrite an existing symlink', async () => {
    expect(await createSharedFolder(root, ' new ')).toEqual({ path: join(root, 'new') });
    await symlink(outside, join(root, 'existing'), 'junction');
    await writeFile(join(outside, 'sentinel.txt'), 'unchanged');
    await expect(createSharedFolder(root, 'existing')).rejects.toThrow();
    expect(await readFile(join(outside, 'sentinel.txt'), 'utf8')).toBe('unchanged');
  });

  it.each(['..', '.', '../escape', 'new/child', 'new\\child']) (
    'rejects unsafe new folder names %s',
    async (name) => {
      await expect(createSharedFolder(root, name)).rejects.toThrow(/niedozwolone/);
    },
  );

  it.skipIf(process.platform === 'win32')('keeps Linux paths case sensitive', async () => {
    const sibling = join(directory, 'PHOTOS');
    await mkdir(sibling);
    await expect(listSharedFolderChildren(sibling)).rejects.toThrow(/udostepnion/);
  });
});
