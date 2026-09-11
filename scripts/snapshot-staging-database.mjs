import { chmod, link, lstat, mkdtemp, open, realpath, rmdir, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const COUNT_TABLES = ['projects', 'photos', 'map_note_photos', 'chat_photo_batches', 'chat_photo_files'];
const SIDECARS = ['-wal', '-shm', '-journal'];
const DEFAULT_RUNTIME_ROOT = fileURLToPath(new URL('../backend', import.meta.url));
const BACKUP_TIMEOUT_MS = 60_000;

class SnapshotError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function failure(code) {
  return new SnapshotError(code);
}

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function inputPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || /[\0\r\n]/.test(value)) {
    throw failure('INVALID_ARGUMENTS');
  }
  return resolve(value);
}

async function absent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw failure('OUTPUT_EXISTS');
}

async function destinationAbsent(output) {
  for (const suffix of ['', ...SIDECARS]) await absent(`${output}${suffix}`);
}

async function checkedPaths(source, output) {
  const requestedSource = inputPath(source);
  const requestedOutput = inputPath(output);
  let sourcePath;
  try {
    const info = await lstat(requestedSource);
    if (!info.isFile() || info.isSymbolicLink()) throw failure('SOURCE_INVALID');
    sourcePath = await realpath(requestedSource);
  } catch { throw failure('SOURCE_INVALID'); }
  let outputDirectory;
  try {
    const info = await lstat(dirname(requestedOutput));
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure('OUTPUT_DIRECTORY_INVALID');
    outputDirectory = await realpath(dirname(requestedOutput));
  } catch { throw failure('OUTPUT_DIRECTORY_INVALID'); }
  const outputPath = join(outputDirectory, basename(requestedOutput));
  if (samePath(sourcePath, outputPath) || samePath(dirname(sourcePath), outputDirectory)) {
    throw failure('SOURCE_DESTINATION_CONFLICT');
  }
  await destinationAbsent(outputPath);
  return { sourcePath, outputPath, outputDirectory };
}

async function nativeDatabase(runtimeRoot) {
  try {
    const runtimePath = inputPath(runtimeRoot);
    if (!(await lstat(runtimePath)).isDirectory()) throw failure('SQLITE_RUNTIME_UNAVAILABLE');
    const require = createRequire(join(runtimePath, 'package.json'));
    return require('better-sqlite3');
  } catch { throw failure('SQLITE_RUNTIME_UNAVAILABLE'); }
}

async function unlinkIfPresent(path) {
  try { await unlink(path); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function removeOwnedOutput(outputPath, identity) {
  try {
    const current = await lstat(outputPath, { bigint: true });
    if (current.isFile() && current.dev === identity.dev && current.ino === identity.ino) {
      await unlink(outputPath);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

/**
 * Create a consistent SQLite database while the native production writer remains live.
 * Only the source connection is readonly; SQLite can maintain its shared-memory index.
 * The snapshot contains private application data and belongs in a private staging directory.
 * The optional clock is a dependency for deterministic deadline testing, not a CLI option.
 */
export async function snapshotDatabase({ source, output, runtimeRoot = DEFAULT_RUNTIME_ROOT } = {},
  { now = () => performance.now() } = {}) {
  let temporaryDirectory;
  let temporaryPath;
  let sourceDatabase;
  let snapshot;
  let result;
  let problem;
  try {
    const { sourcePath, outputPath, outputDirectory } = await checkedPaths(source, output);
    const Database = await nativeDatabase(runtimeRoot);
    temporaryDirectory = await mkdtemp(join(outputDirectory, '.photolocal-snapshot-'));
    await chmod(temporaryDirectory, 0o700);
    temporaryPath = join(temporaryDirectory, 'snapshot.sqlite');
    const reserved = await open(temporaryPath, 'wx', 0o600);
    await reserved.close();
    sourceDatabase = new Database(sourcePath, { readonly: true, fileMustExist: true, timeout: 5000 });
    const startedAt = now();
    const checkDeadline = () => {
      if (now() - startedAt >= BACKUP_TIMEOUT_MS) throw failure('SNAPSHOT_TIMEOUT');
    };
    // The supported online API reads committed WAL data and restarts safely if another
    // connection writes. Its callback may abort a busy backup without publishing a partial file.
    // https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#backupdestination-options---promise
    await sourceDatabase.backup(temporaryPath, { progress: checkDeadline });
    checkDeadline();
    sourceDatabase.close();
    sourceDatabase = undefined;

    snapshot = new Database(temporaryPath, { fileMustExist: true, timeout: 5000 });
    // A standalone snapshot must not depend on sidecars when moved into the Linux migration.
    snapshot.pragma('journal_mode = DELETE');
    const integrity = snapshot.pragma('integrity_check');
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') {
      throw failure('SNAPSHOT_INTEGRITY_FAILED');
    }
    const tablePresent = snapshot.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?");
    const counts = Object.fromEntries(COUNT_TABLES.map((table) => [table,
      tablePresent.get(table) ? snapshot.prepare(`SELECT count(*) FROM ${table}`).pluck().get() : null,
    ]));
    snapshot.close();
    snapshot = undefined;
    await chmod(temporaryPath, 0o600);
    await destinationAbsent(outputPath);
    const identity = await lstat(temporaryPath, { bigint: true });
    try {
      // link() is atomic and fails when a competing process has already created the output.
      await link(temporaryPath, outputPath);
    } catch (error) {
      if (error?.code === 'EEXIST') throw failure('OUTPUT_EXISTS');
      throw failure('SNAPSHOT_PUBLISH_FAILED');
    }
    try {
      for (const suffix of SIDECARS) await absent(`${outputPath}${suffix}`);
    } catch (error) {
      await removeOwnedOutput(outputPath, identity);
      throw error;
    }
    result = { status: 'SNAPSHOT_OK', output: outputPath, counts };
  } catch (error) {
    problem = error instanceof SnapshotError ? error : failure('SNAPSHOT_FAILED');
  } finally {
    try {
      if (snapshot?.open) snapshot.close();
      if (sourceDatabase?.open) sourceDatabase.close();
      if (temporaryPath) {
        // Never recurse: these names are confined to the newly created private directory.
        for (const suffix of ['', ...SIDECARS]) await unlinkIfPresent(`${temporaryPath}${suffix}`);
      }
      if (temporaryDirectory) await rmdir(temporaryDirectory);
    } catch { problem = failure('SNAPSHOT_CLEANUP_REQUIRED'); }
  }
  if (problem) throw problem;
  return result;
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: {
      source: { type: 'string' }, output: { type: 'string' }, 'runtime-root': { type: 'string' },
    }, strict: true, allowPositionals: false }));
  } catch {
    process.stdout.write(`${JSON.stringify({ status: 'INVALID_ARGUMENTS' })}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    const result = await snapshotDatabase({ source: values.source, output: values.output,
      runtimeRoot: values['runtime-root'] ?? DEFAULT_RUNTIME_ROOT });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const status = error instanceof SnapshotError ? error.code : 'SNAPSHOT_FAILED';
    process.stdout.write(`${JSON.stringify({ status })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
