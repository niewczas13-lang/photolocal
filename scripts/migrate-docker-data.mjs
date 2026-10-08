import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, posix, relative, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const FILESYSTEM_COLUMNS = [
  ['projects', 'base_folder'],
  ['photos', 'storage_path'],
  ['photos', 'thumbnail_path'],
  ['map_note_photos', 'storage_path'],
  ['map_note_photos', 'thumbnail_path'],
  ['project_photo_hash_cache', 'storage_path'],
  ['chat_photo_batches', 'folder_path'],
  ['chat_photo_files', 'source_path'],
];
const SQLITE_SIDECARS = ['-wal', '-shm', '-journal'];

function isWindowsAbsolute(value) {
  return /^[a-z]:[\\/]/i.test(value) || /^[/\\]{2}[^/\\?.]+[/\\][^/\\]+(?:[/\\]|$)/.test(value);
}

function hasUnsafeSegments(value) {
  return value.includes('\0') || value.split(/[/\\]/).some((part) => part === '..' || part === '.');
}

function insidePosix(candidate, root) {
  const difference = posix.relative(root, candidate);
  return difference === '' || (
    difference !== '..' && !difference.startsWith('../') && !posix.isAbsolute(difference)
  );
}

/** Validate a JSON array of explicit Windows-prefix -> Linux-prefix mappings. */
export function validateMappings(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('The mapping must be a non-empty JSON array of { from, to } objects');
  }
  const mappings = value.map((entry) => {
    if (
      !entry || typeof entry !== 'object' || typeof entry.from !== 'string' ||
      typeof entry.to !== 'string' || entry.from !== entry.from.trim() ||
      entry.to !== entry.to.trim() || !isWindowsAbsolute(entry.from) ||
      !posix.isAbsolute(entry.to) || entry.to.startsWith('//') || entry.to.includes('\\') ||
      hasUnsafeSegments(entry.from) || hasUnsafeSegments(entry.to)
    ) {
      throw new Error('Each mapping requires an absolute Windows from and absolute Linux to without traversal');
    }
    const normalizedFrom = win32.normalize(entry.from);
    const from = /^[a-z]:\\$/i.test(normalizedFrom)
      ? normalizedFrom : normalizedFrom.replace(/\\$/, '');
    const to = posix.normalize(entry.to).replace(/\/$/, '') || '/';
    return { from, to };
  });
  for (let index = 0; index < mappings.length; index += 1) {
    for (const previous of mappings.slice(0, index)) {
      const current = mappings[index];
      if (current.from.toLowerCase() === previous.from.toLowerCase()) {
        throw new Error('Duplicate Windows prefix in mapping');
      }
      if (insidePosix(current.to, previous.to) || insidePosix(previous.to, current.to)) {
        throw new Error('Linux mapping destinations must not overlap, so rollback stays unambiguous');
      }
    }
  }
  return mappings;
}

/** Relative values are retained; absolute values must belong to an explicit mapping. */
export function remapPath(value, mappings) {
  if (value === null || value === '') return value;
  if (typeof value !== 'string' || hasUnsafeSegments(value)) {
    throw new Error('Unsupported path');
  }
  if (isWindowsAbsolute(value)) {
    for (const entry of [...mappings].sort((left, right) => right.from.length - left.from.length)) {
      const difference = win32.relative(entry.from, win32.normalize(value));
      if (difference === '' || (
        difference !== '..' && !difference.startsWith('..\\') && !win32.isAbsolute(difference)
      )) {
        return posix.join(entry.to, difference.replaceAll('\\', '/'));
      }
    }
    throw new Error('Unmapped absolute path');
  }
  if (posix.isAbsolute(value)) {
    if (mappings.some((entry) => insidePosix(value, entry.to))) return value;
    throw new Error('Unmapped absolute path');
  }
  if (/^[a-z]:|^\\/i.test(value)) throw new Error('Unsupported path');
  return value;
}

async function requireAbsent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Output already exists: ${path}`);
}

function remapDatabase(db, mappings) {
  const columns = [];
  db.transaction(() => {
    for (const [table, column] of FILESYSTEM_COLUMNS) {
      const present = db.prepare(`PRAGMA table_info(${table})`).all()
        .some((entry) => entry.name === column);
      if (!present) {
        columns.push({ table, column, scanned: 0, changed: 0, skipped: true });
        continue;
      }
      const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
      const rows = db.prepare(`SELECT rowid AS row_id, ${column} AS path FROM ${table}`).all();
      let changed = 0;
      for (const row of rows) {
        let remapped;
        try {
          remapped = remapPath(row.path, mappings);
        } catch (error) {
          throw new Error(`${error instanceof Error ? error.message : 'Invalid path'} in ${table}.${column} (row ${row.row_id})`);
        }
        if (remapped !== row.path) {
          update.run(remapped, row.row_id);
          changed += 1;
        }
      }
      columns.push({ table, column, scanned: rows.length, changed, skipped: false });
    }
  })();
  return columns;
}

async function removePublishedFile(path, identity) {
  try {
    const current = await lstat(path, { bigint: true });
    // Never delete another actor's replacement, including a symlink.
    if (current.isFile() && current.dev === identity.dev && current.ino === identity.ino) {
      await unlink(path);
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

async function fingerprint(path) {
  let info;
  try {
    info = await lstat(path, { bigint: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile()) throw new Error('Source database and sidecars must be regular files');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const after = await lstat(path, { bigint: true });
  if (info.dev !== after.dev || info.ino !== after.ino || info.size !== after.size ||
    info.mtimeNs !== after.mtimeNs || info.ctimeNs !== after.ctimeNs) {
    throw new Error('Source changed during snapshot; stop all source writers and retry');
  }
  return { info, hash: hash.digest('hex') };
}

async function snapshotOfflineSource(sourcePath, temporaryDirectory) {
  // Do not open the original in SQLite: even a readonly connection may create its SHM file.
  // SHM is a rebuildable index, so copy only main/WAL/rollback-journal into the private directory.
  const suffixes = ['', '-wal', '-journal'];
  const snapshots = [];
  for (const suffix of suffixes) snapshots.push(await fingerprint(`${sourcePath}${suffix}`));
  const snapshotPath = join(temporaryDirectory, 'source-snapshot.sqlite');
  for (let index = 0; index < suffixes.length; index += 1) {
    if (!snapshots[index]) continue;
    const target = `${snapshotPath}${suffixes[index]}`;
    await copyFile(`${sourcePath}${suffixes[index]}`, target, constants.COPYFILE_EXCL);
    await chmod(target, 0o600);
  }
  for (let index = 0; index < suffixes.length; index += 1) {
    const before = snapshots[index];
    const after = await fingerprint(`${sourcePath}${suffixes[index]}`);
    const copied = await fingerprint(`${snapshotPath}${suffixes[index]}`);
    if ((!before) !== (!after) || before?.hash !== after?.hash || before?.hash !== copied?.hash ||
      before?.info.dev !== after?.info.dev || before?.info.ino !== after?.info.ino ||
      before?.info.size !== after?.info.size || before?.info.mtimeNs !== after?.info.mtimeNs ||
      before?.info.ctimeNs !== after?.info.ctimeNs) {
      throw new Error('Source changed during snapshot; stop all source writers and retry');
    }
  }
  return snapshotPath;
}

/**
 * Offline DB-only migration. Quiesce the source application and snapshot photo/download files
 * separately at the same point in time. Never mount writable production folders into staging.
 * Original files are only read/copied. SQLite's backup API runs on a verified private snapshot,
 * including committed WAL pages, so even SQLite's sidecar creation cannot touch the original.
 */
export async function migrateDockerData({ source, output, mapping }) {
  const mappings = validateMappings(mapping);
  if (typeof source !== 'string' || typeof output !== 'string' || !source || !output ||
    source !== source.trim() || output !== output.trim()) {
    throw new Error('Source and output database filenames are required without surrounding whitespace');
  }
  const sourcePath = await realpath(resolve(source));
  if (!(await lstat(sourcePath)).isFile()) throw new Error('Source must be a regular database file');
  const outputDirectory = await realpath(dirname(resolve(output)));
  const outputPath = join(outputDirectory, basename(resolve(output)));
  const reportPath = `${outputPath}.migration.json`;
  const outputs = [outputPath, reportPath, ...SQLITE_SIDECARS.map((suffix) => `${outputPath}${suffix}`)];
  const sourceFiles = [sourcePath, ...SQLITE_SIDECARS.map((suffix) => `${sourcePath}${suffix}`)];
  if (outputs.some((path) => sourceFiles.some((existing) => relative(existing, path) === ''))) {
    throw new Error('Output must not replace the source database or its SQLite sidecars');
  }
  for (const path of outputs) await requireAbsent(path);

  const temporaryDirectory = await mkdtemp(join(outputDirectory, '.photolocal-migrate-'));
  const temporaryDirectoryIdentity = await lstat(temporaryDirectory, { bigint: true });
  const temporaryDb = join(temporaryDirectory, 'database.sqlite');
  const temporaryReport = join(temporaryDirectory, 'report.json');
  const published = [];
  try {
    const snapshotPath = await snapshotOfflineSource(sourcePath, temporaryDirectory);
    const sourceDb = new Database(snapshotPath, { fileMustExist: true });
    try {
      await sourceDb.backup(temporaryDb);
    } finally {
      sourceDb.close();
    }
    await chmod(temporaryDb, 0o600);
    const destinationDb = new Database(temporaryDb, { fileMustExist: true });
    let columns;
    try {
      destinationDb.pragma('journal_mode = DELETE');
      columns = remapDatabase(destinationDb, mappings);
      if (destinationDb.pragma('integrity_check', { simple: true }) !== 'ok') {
        throw new Error('Migrated SQLite database failed integrity_check');
      }
    } finally {
      destinationDb.close();
    }
    const report = {
      version: 1,
      createdAt: new Date().toISOString(),
      sourceDatabase: basename(sourcePath),
      outputDatabase: basename(outputPath),
      databaseOnly: true,
      integrityCheck: 'ok',
      mapping: mappings,
      rollbackMapping: mappings.map(({ from, to }) => ({ from: to, to: from })),
      columns,
    };
    await writeFile(temporaryReport, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    // Publish complete files without replacing existing paths. Both reside on this filesystem.
    for (const [temporary, finalPath] of [[temporaryDb, outputPath], [temporaryReport, reportPath]]) {
      const identity = await lstat(temporary, { bigint: true });
      await link(temporary, finalPath);
      published.push({ path: finalPath, identity });
    }
    return report;
  } catch (error) {
    for (const { path, identity } of published.reverse()) await removePublishedFile(path, identity);
    throw error;
  } finally {
    // Only recursively remove the verified, private mkdtemp directory we just created.
    const cleanupPath = await realpath(temporaryDirectory);
    const cleanupIdentity = await lstat(cleanupPath, { bigint: true });
    if (relative(temporaryDirectory, cleanupPath) !== '' ||
      relative(outputDirectory, dirname(cleanupPath)) !== '' ||
      cleanupIdentity.dev !== temporaryDirectoryIdentity.dev ||
      cleanupIdentity.ino !== temporaryDirectoryIdentity.ino ||
      !basename(cleanupPath).startsWith('.photolocal-migrate-')) {
      throw new Error('Refusing to clean up an unexpected migration directory');
    }
    await rm(cleanupPath, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      source: { type: 'string' }, output: { type: 'string' }, mapping: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    process.stdout.write('Usage: node scripts/migrate-docker-data.mjs --source <db> --output <new-db> --mapping <json-file>\n' +
      'Mapping: [{"from":"P:\\\\Projects","to":"/photos"}]\n' +
      'Stop source writes and snapshot matching photo/download files separately. This utility migrates only a DB copy.\n');
    return;
  }
  if (!values.source || !values.output || !values.mapping) {
    throw new Error('Provide --source, --output and --mapping (see --help)');
  }
  const mapping = JSON.parse(await readFile(values.mapping, 'utf8'));
  const report = await migrateDockerData({ source: values.source, output: values.output, mapping });
  const changed = report.columns.reduce((total, entry) => total + entry.changed, 0);
  process.stdout.write(`Migrated ${changed} filesystem values. Report: ${resolve(values.output)}.migration.json\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Migration failed'}\n`);
    process.exitCode = 1;
  });
}
