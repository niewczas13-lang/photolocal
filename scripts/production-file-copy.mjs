import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile as nativeCopyFile, lstat, mkdir, open, opendir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';

const MAX_ENTRIES = 250_000;
const DEFAULT_MAX_MS = 60 * 60 * 1000;
const COPY_ERRORS = new Set([
  'LOCAL_COPY_INVALID_PATH', 'LOCAL_COPY_DESTINATION_NOT_EMPTY', 'LOCAL_COPY_UNSAFE_PATH',
  'LOCAL_COPY_SOURCE_CHANGED', 'LOCAL_COPY_DESTINATION_CHANGED', 'LOCAL_COPY_VERIFICATION_FAILED',
  'LOCAL_COPY_SCAN_LIMIT', 'LOCAL_COPY_TIMEOUT', 'LOCAL_COPY_FAILED',
]);

function fail(code) { throw Object.assign(new Error(code), { code }); }
function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function inside(candidate, root) {
  const difference = relative(root, candidate);
  return difference === '' || (difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference));
}
function inputPath(value) {
  if (typeof value !== 'string' || value !== value.trim() || !isAbsolute(value) || /[\0\r\n]/.test(value) ||
      value.split(/[\\/]/).some(part => part === '.' || part === '..') ||
      (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(value))) fail('LOCAL_COPY_INVALID_PATH');
  return resolve(value);
}
function sameIdentity(left, right, file = true) {
  return left.dev === right.dev && left.ino === right.ino && (!file ||
    (left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs));
}

/** Protected destination ACLs are supplied by preparation; recheck every ancestor before writes. */
async function plainAncestors(path, file = false) {
  let current = path;
  let first = true;
  let requested;
  while (true) {
    const info = await lstat(current, { bigint: true });
    if (info.isSymbolicLink() || (first && file ? !info.isFile() : !info.isDirectory()) ||
        !samePath(await realpath(current), current)) fail('LOCAL_COPY_UNSAFE_PATH');
    if (first) requested = info;
    const parent = dirname(current);
    if (parent === current) break;
    first = false;
    current = parent;
  }
  return requested;
}

async function inventory(root, checkDeadline, maxEntries) {
  const result = { entries: new Map(), files: 0, bytes: 0 };
  const pending = [''];
  result.entries.set('', { type: 'directory', info: await plainAncestors(root) });
  let visited = 0;
  while (pending.length > 0) {
    checkDeadline();
    const directory = pending.pop();
    const absolute = join(root, directory);
    await plainAncestors(absolute);
    const handle = await opendir(absolute);
    for await (const entry of handle) {
      checkDeadline();
      if (++visited > maxEntries) fail('LOCAL_COPY_SCAN_LIMIT');
      const item = join(directory, entry.name);
      const path = join(root, item);
      if (!inside(path, root) || entry.isSymbolicLink()) fail('LOCAL_COPY_UNSAFE_PATH');
      const info = await lstat(path, { bigint: true });
      if (info.isSymbolicLink()) fail('LOCAL_COPY_UNSAFE_PATH');
      if (info.isDirectory()) {
        result.entries.set(item, { type: 'directory', info });
        pending.push(item);
      } else if (info.isFile()) {
        const bytes = Number(info.size);
        if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(result.bytes + bytes)) fail('LOCAL_COPY_SCAN_LIMIT');
        result.entries.set(item, { type: 'file', info });
        result.files += 1;
        result.bytes += bytes;
      } else fail('LOCAL_COPY_UNSAFE_PATH');
    }
  }
  return result;
}

async function expectedFile(path, expected, changedCode) {
  try {
    const info = await plainAncestors(path, true);
    if (!sameIdentity(info, expected)) fail(changedCode);
    return info;
  } catch (error) {
    if (COPY_ERRORS.has(error?.code)) throw error;
    fail(changedCode);
  }
}

async function hashFile(path, expected, changedCode, checkDeadline, buffer) {
  let handle;
  try {
    checkDeadline();
    await expectedFile(path, expected, changedCode);
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameIdentity(before, expected)) fail(changedCode);
    const digest = createHash('sha256');
    while (true) {
      checkDeadline();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
    checkDeadline();
    if (!sameIdentity(await handle.stat({ bigint: true }), expected)) fail(changedCode);
    await expectedFile(path, expected, changedCode);
    return digest.digest('hex');
  } catch (error) {
    if (COPY_ERRORS.has(error?.code)) throw error;
    fail(changedCode);
  } finally {
    if (handle) await handle.close();
  }
}

function compareInventories(expected, actual, changedCode) {
  if (expected.size !== actual.size) fail(changedCode);
  for (const [name, entry] of expected) {
    const current = actual.get(name);
    if (!current || current.type !== entry.type || !sameIdentity(entry.info, current.info, entry.type === 'file')) fail(changedCode);
  }
}

/** Copy a quiescent local tree into a fresh private directory; retain partial output on failure. */
export async function copyVerifiedLocalTree({ source, destination } = {}, {
  onProgress, now = () => performance.now(), maxMs = DEFAULT_MAX_MS,
  copyFile = nativeCopyFile, maxEntries = MAX_ENTRIES,
} = {}) {
  try {
    source = inputPath(source);
    destination = inputPath(destination);
    if (inside(source, destination) || inside(destination, source) ||
        !Number.isFinite(maxMs) || maxMs <= 0 || maxMs > DEFAULT_MAX_MS ||
        !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_ENTRIES ||
        typeof now !== 'function' || typeof copyFile !== 'function' ||
        (onProgress !== undefined && typeof onProgress !== 'function')) fail('LOCAL_COPY_INVALID_PATH');
    const started = now();
    const checkDeadline = () => { if (now() - started >= maxMs) fail('LOCAL_COPY_TIMEOUT'); };
    checkDeadline();
    await plainAncestors(source);
    const destinationInfo = await plainAncestors(destination);
    const destinationHandle = await opendir(destination);
    try { if (await destinationHandle.read()) fail('LOCAL_COPY_DESTINATION_NOT_EMPTY'); }
    finally { await destinationHandle.close(); }
    const original = await inventory(source, checkDeadline, maxEntries);
    const destinationEntries = new Map([['', { type: 'directory', info: destinationInfo }]]);
    const progress = { files: 0, bytes: 0, totalFiles: original.files, totalBytes: original.bytes };
    let lastProgress = now();
    let lastProgressFiles = 0;
    async function emitProgress(force = false) {
      const timestamp = now();
      if (onProgress && (force || progress.files - lastProgressFiles >= 100 || timestamp - lastProgress >= 1000)) {
        try { await onProgress({ ...progress }); } catch { /* Display failure cannot invalidate copied data. */ }
        lastProgress = timestamp;
        lastProgressFiles = progress.files;
      }
      checkDeadline();
    }
    await emitProgress(true);

    const directories = [...original.entries].filter(([name, entry]) => name && entry.type === 'directory')
      .sort(([left], [right]) => left.split(sep).length - right.split(sep).length || left.localeCompare(right));
    for (const [name, entry] of directories) {
      checkDeadline();
      const sourceInfo = await plainAncestors(join(source, name));
      if (!sameIdentity(sourceInfo, entry.info, false)) fail('LOCAL_COPY_SOURCE_CHANGED');
      await plainAncestors(dirname(join(destination, name)));
      await mkdir(join(destination, name), { mode: 0o700 });
      destinationEntries.set(name, { type: 'directory', info: await plainAncestors(join(destination, name)) });
    }

    const hashes = new Map();
    const files = [...original.entries].filter(([, entry]) => entry.type === 'file').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const hashBuffer = Buffer.allocUnsafe(1024 * 1024);
    for (const [name, entry] of files) {
      checkDeadline();
      const sourcePath = join(source, name);
      const destinationPath = join(destination, name);
      await expectedFile(sourcePath, entry.info, 'LOCAL_COPY_SOURCE_CHANGED');
      const parent = relative(destination, dirname(destinationPath));
      const parentInfo = await plainAncestors(dirname(destinationPath));
      if (!sameIdentity(parentInfo, destinationEntries.get(parent).info, false)) fail('LOCAL_COPY_DESTINATION_CHANGED');
      try { await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL); }
      catch (error) { fail(error?.code === 'EEXIST' ? 'LOCAL_COPY_DESTINATION_CHANGED' : 'LOCAL_COPY_FAILED'); }
      checkDeadline();
      await expectedFile(sourcePath, entry.info, 'LOCAL_COPY_SOURCE_CHANGED');
      const copied = await plainAncestors(destinationPath, true);
      if (copied.size !== entry.info.size || (copied.dev === entry.info.dev && copied.ino === entry.info.ino)) fail('LOCAL_COPY_VERIFICATION_FAILED');
      const sourceHash = await hashFile(sourcePath, entry.info, 'LOCAL_COPY_SOURCE_CHANGED', checkDeadline, hashBuffer);
      const copiedHash = await hashFile(destinationPath, copied, 'LOCAL_COPY_DESTINATION_CHANGED', checkDeadline, hashBuffer);
      if (sourceHash !== copiedHash) fail('LOCAL_COPY_VERIFICATION_FAILED');
      await expectedFile(sourcePath, entry.info, 'LOCAL_COPY_SOURCE_CHANGED');
      destinationEntries.set(name, { type: 'file', info: copied });
      hashes.set(name, copiedHash);
      progress.files += 1;
      progress.bytes += Number(entry.info.size);
      await emitProgress(progress.files === progress.totalFiles);
    }
    if (files.length === 0) await emitProgress(true);
    const finalSource = await inventory(source, checkDeadline, maxEntries);
    compareInventories(original.entries, finalSource.entries, 'LOCAL_COPY_SOURCE_CHANGED');
    const finalDestination = await inventory(destination, checkDeadline, maxEntries);
    compareInventories(destinationEntries, finalDestination.entries, 'LOCAL_COPY_DESTINATION_CHANGED');
    const tree = createHash('sha256');
    for (const name of [...original.entries.keys()].sort()) {
      const entry = original.entries.get(name);
      tree.update(JSON.stringify([entry.type, name.split(sep).join('/'),
        entry.type === 'file' ? entry.info.size.toString() : null, hashes.get(name) ?? null]) + '\n');
    }
    checkDeadline();
    return { status: 'LOCAL_COPY_VERIFIED', files: progress.files, bytes: progress.bytes, treeHash: tree.digest('hex') };
  } catch (error) {
    fail(COPY_ERRORS.has(error?.code) ? error.code : 'LOCAL_COPY_FAILED');
  }
}
