import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { copyVerifiedLocalTree } from './production-file-copy.mjs';

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'photolocal-file-copy-'));
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  await mkdir(source);
  await mkdir(destination);
  context.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.match(root, /photolocal-file-copy-[^\\/]+$/);
    await rm(root, { recursive: true, force: true });
  });
  return { root, source, destination };
}

test('copies all hidden files and empty directories with verified independent file content', async context => {
  const f = await fixture(context);
  await mkdir(join(f.source, '.receipts'));
  await mkdir(join(f.source, 'empty'));
  await writeFile(join(f.source, '.spaces.json'), '{}');
  await writeFile(join(f.source, '.receipts', 'żółć.json'), 'receipt');
  await writeFile(join(f.source, 'photo.jpg'), Buffer.alloc(1024 * 1024, 27));
  const sourceBefore = await lstat(join(f.source, 'photo.jpg'), { bigint: true });
  const progress = [];
  const report = await copyVerifiedLocalTree(f, { onProgress: update => progress.push(update) });
  assert.equal(report.status, 'LOCAL_COPY_VERIFIED');
  assert.equal(report.files, 3);
  assert.equal(report.bytes, 1024 * 1024 + 9);
  assert.match(report.treeHash, /^[a-f0-9]{64}$/);
  assert.deepEqual((await readdir(f.destination)).sort(), ['.receipts', '.spaces.json', 'empty', 'photo.jpg']);
  assert.deepEqual(await readdir(join(f.destination, 'empty')), []);
  assert.equal(await readFile(join(f.destination, '.receipts', 'żółć.json'), 'utf8'), 'receipt');
  const sourceAfter = await lstat(join(f.source, 'photo.jpg'), { bigint: true });
  const copied = await lstat(join(f.destination, 'photo.jpg'), { bigint: true });
  assert.equal(sourceAfter.ino, sourceBefore.ino);
  assert.equal(sourceAfter.mtimeNs, sourceBefore.mtimeNs);
  assert.notEqual(copied.ino, sourceAfter.ino, 'copy must not be a hard link');
  assert.deepEqual(progress.at(-1), { files: report.files, bytes: report.bytes, totalFiles: report.files, totalBytes: report.bytes });
  assert.ok(progress.every(value => Object.keys(value).sort().join(',') === 'bytes,files,totalBytes,totalFiles'));
});

test('tree hash is reproducible for equal contents and progress callback failures do not stop copying', async context => {
  const f = await fixture(context);
  await writeFile(join(f.source, 'image.jpg'), 'contents');
  const first = await copyVerifiedLocalTree(f, { onProgress: () => { throw new Error('display failed'); } });
  const secondDestination = join(f.root, 'second');
  await mkdir(secondDestination);
  const second = await copyVerifiedLocalTree({ source: f.source, destination: secondDestination });
  assert.equal(first.treeHash, second.treeHash);
});

test('existing destination entries and root overlap are refused without altering files', async context => {
  const f = await fixture(context);
  await writeFile(join(f.destination, 'sentinel'), 'keep');
  await assert.rejects(copyVerifiedLocalTree(f), { code: 'LOCAL_COPY_DESTINATION_NOT_EMPTY' });
  assert.equal(await readFile(join(f.destination, 'sentinel'), 'utf8'), 'keep');
  const nested = join(f.source, 'nested');
  await mkdir(nested);
  for (const input of [
    { source: f.source, destination: f.source },
    { source: f.source, destination: nested },
    { source: nested, destination: f.source },
  ]) await assert.rejects(copyVerifiedLocalTree(input), { code: 'LOCAL_COPY_INVALID_PATH' });
});

test('source or destination junctions and symlink ancestors are never traversed', async context => {
  const f = await fixture(context);
  const outside = join(f.root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'sentinel'), 'keep');
  const kind = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(outside, join(f.source, 'linked'), kind);
  await assert.rejects(copyVerifiedLocalTree(f), { code: 'LOCAL_COPY_UNSAFE_PATH' });
  const ancestor = join(f.root, 'ancestor');
  await symlink(f.source, ancestor, kind);
  await assert.rejects(copyVerifiedLocalTree({ source: ancestor, destination: f.destination }), { code: 'LOCAL_COPY_UNSAFE_PATH' });
  assert.deepEqual(await readdir(f.destination), []);
  assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'keep');
});

test('a directory swapped for a junction after inventory is rejected before copying into it', async context => {
  const f = await fixture(context);
  const subdirectory = join(f.source, 'nested');
  const outside = join(f.root, 'outside');
  await mkdir(subdirectory);
  await mkdir(outside);
  await writeFile(join(subdirectory, 'image.jpg'), 'source');
  await writeFile(join(outside, 'image.jpg'), 'outside');
  let swapped = false;
  await assert.rejects(copyVerifiedLocalTree(f, { onProgress: async update => {
    if (!swapped && update.files === 0) {
      swapped = true;
      await rename(subdirectory, join(f.source, 'old-nested'));
      await symlink(outside, subdirectory, process.platform === 'win32' ? 'junction' : 'dir');
    }
  } }), error => ['LOCAL_COPY_UNSAFE_PATH', 'LOCAL_COPY_SOURCE_CHANGED'].includes(error.code));
  assert.equal(await readFile(join(outside, 'image.jpg'), 'utf8'), 'outside');
});

test('source rewrite during copying is detected and the partial destination is retained', async context => {
  const f = await fixture(context);
  await writeFile(join(f.source, 'image.jpg'), 'original');
  await assert.rejects(copyVerifiedLocalTree(f, { copyFile: async (source, destination, flags) => {
    assert.equal(flags, constants.COPYFILE_EXCL);
    await copyFile(source, destination, flags);
    await writeFile(source, 'changed-original');
  } }), { code: 'LOCAL_COPY_SOURCE_CHANGED' });
  assert.equal(await readFile(join(f.destination, 'image.jpg'), 'utf8'), 'original');
  assert.equal(await readFile(join(f.source, 'image.jpg'), 'utf8'), 'changed-original');
});

test('mismatched copied content fails verification without deleting the partial file', async context => {
  const f = await fixture(context);
  await writeFile(join(f.source, 'image.jpg'), 'original');
  await assert.rejects(copyVerifiedLocalTree(f, { copyFile: async (source, destination, flags) => {
    await copyFile(source, destination, flags);
    await writeFile(destination, 'corrupt!');
  } }), { code: 'LOCAL_COPY_VERIFICATION_FAILED' });
  assert.equal(await readFile(join(f.source, 'image.jpg'), 'utf8'), 'original');
  assert.equal(await readFile(join(f.destination, 'image.jpg'), 'utf8'), 'corrupt!');
});

test('late source additions and destination extras are detected by final inventories', async context => {
  for (const side of ['source', 'destination']) {
    const f = await fixture(context);
    await writeFile(join(f.source, 'image.jpg'), 'original');
    let added = false;
    await assert.rejects(copyVerifiedLocalTree(f, { onProgress: async update => {
      if (!added && update.files === 1) {
        added = true;
        await writeFile(join(f[side], 'late.jpg'), 'late');
      }
    } }), { code: side === 'source' ? 'LOCAL_COPY_SOURCE_CHANGED' : 'LOCAL_COPY_DESTINATION_CHANGED' });
    assert.equal(await readFile(join(f.destination, 'image.jpg'), 'utf8'), 'original');
  }
});

test('deleting a source file during copying cannot return a verified result', async context => {
  const f = await fixture(context);
  await writeFile(join(f.source, 'image.jpg'), 'original');
  await assert.rejects(copyVerifiedLocalTree(f, { copyFile: async (source, destination, flags) => {
    await copyFile(source, destination, flags);
    await rm(source);
  } }), { code: 'LOCAL_COPY_SOURCE_CHANGED' });
  assert.equal(await readFile(join(f.destination, 'image.jpg'), 'utf8'), 'original');
});

test('runtime limit is bounded and failure output never contains source paths or underlying messages', async context => {
  const f = await fixture(context);
  await writeFile(join(f.source, 'private-name.jpg'), 'original');
  let elapsed = 0;
  await assert.rejects(copyVerifiedLocalTree(f, { maxMs: 1, now: () => elapsed++ }), { code: 'LOCAL_COPY_TIMEOUT' });
  await assert.rejects(copyVerifiedLocalTree(f, { copyFile: async () => { throw new Error('PRIVATE_ERROR_SECRET'); } }), error => {
    assert.equal(error.code, 'LOCAL_COPY_FAILED');
    assert.equal(error.message, error.code);
    assert.equal(JSON.stringify(error).includes('PRIVATE_ERROR_SECRET'), false);
    assert.equal(JSON.stringify(error).includes(f.source), false);
    return true;
  });
});

test('entry limit rejects a larger tree before copying any file', async context => {
  const f = await fixture(context);
  await writeFile(join(f.source, 'first.jpg'), 'first');
  await writeFile(join(f.source, 'second.jpg'), 'second');
  await assert.rejects(copyVerifiedLocalTree(f, { maxEntries: 1 }), { code: 'LOCAL_COPY_SCAN_LIMIT' });
  assert.deepEqual(await readdir(f.destination), []);
});

test('destination parent replaced by a junction between files is rejected before outside writes', async context => {
  const f = await fixture(context);
  await writeFile(join(f.source, 'a.jpg'), 'first');
  await mkdir(join(f.source, 'z'));
  await writeFile(join(f.source, 'z', 'image.jpg'), 'second');
  const outside = join(f.root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'protected-sentinel'), 'keep');
  let elapsed = 0;
  let swapped = false;
  await assert.rejects(copyVerifiedLocalTree(f, {
    now: () => { elapsed += 1000; return elapsed; },
    onProgress: async update => {
      if (!swapped && update.files === 1) {
        swapped = true;
        await rename(join(f.destination, 'z'), join(f.destination, 'old-z'));
        await symlink(outside, join(f.destination, 'z'), process.platform === 'win32' ? 'junction' : 'dir');
      }
    },
  }), { code: 'LOCAL_COPY_UNSAFE_PATH' });
  assert.equal(await readFile(join(outside, 'protected-sentinel'), 'utf8'), 'keep');
  await assert.rejects(lstat(join(outside, 'image.jpg')), { code: 'ENOENT' });
});

test('a hardlinked result can never be accepted as an independent copy', async context => {
  const f = await fixture(context);
  await writeFile(join(f.source, 'image.jpg'), 'original');
  await assert.rejects(copyVerifiedLocalTree(f, { copyFile: async (source, destination) => link(source, destination) }),
    error => ['LOCAL_COPY_SOURCE_CHANGED', 'LOCAL_COPY_VERIFICATION_FAILED'].includes(error.code));
  assert.equal(await readFile(join(f.source, 'image.jpg'), 'utf8'), 'original');
});
