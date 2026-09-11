import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkWindowsPaths, compareFailurePaths, groupComparisons, diagnoseStagingCopy } from './diagnose-staging-copy.mjs';

const mappings = [
  { from: 'Z:\\Projects', to: '/nas/Projects' },
  { from: 'C:\\PhotoLocal\\backend\\zdjęcia', to: '/legacy-local-photos' },
];

test('failed NAS paths map to UNC while local paths retain the original native prefix', () => {
  const failures = [
    { kind: 'project_folder', projectId: 'p1', photoId: null, path: '/nas/Projects/Job', reason: 'ENOENT' },
    { kind: 'photo', projectId: 'p1', photoId: 'f1', path: '/legacy-local-photos/photo.jpg', reason: 'EACCES' },
  ];
  const checks = compareFailurePaths(failures, mappings, '\\\\192.0.2.70\\Photos', 'Projects');
  assert.equal(checks[0].windowsPath, '\\\\192.0.2.70\\Photos\\Projects\\Job');
  assert.equal(checks[1].windowsPath, 'C:\\PhotoLocal\\backend\\zdjęcia\\photo.jpg');
  assert.equal(checks[0].linuxResult, 'ENOENT');
});

test('invalid and escaping database paths never produce a Windows file read request', () => {
  const checks = compareFailurePaths(['/nas/Projects/../secret', '/google/token.json', '/nas/Projects-other/private', 'relative.jpg'].map(path => ({ path, kind: 'photo', reason: 'PATH_REJECTED' })), mappings, '\\\\192.0.2.70\\Photos', 'Projects');
  assert.ok(checks.every(check => check.windowsPath === null));
  assert.throws(() => compareFailurePaths([], mappings, '\\single\\slash', 'Projects'), { code: 'INVALID_WINDOWS_SHARE' });
});

test('native path checks distinguish absent, empty and regular files without altering them', context => {
  const folder = fs.mkdtempSync(join(tmpdir(), 'photolocal-path-check-'));
  context.after(() => {
    assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
    fs.rmSync(folder, { recursive: true, force: true });
  });
  fs.writeFileSync(join(folder, 'ok.jpg'), 'original');
  fs.writeFileSync(join(folder, 'empty.jpg'), '');
  const result = checkWindowsPaths([
    { kind: 'project_folder', windowsPath: folder },
    { kind: 'photo', windowsPath: join(folder, 'ok.jpg') },
    { kind: 'photo', windowsPath: join(folder, 'missing.jpg') },
    { kind: 'photo', windowsPath: join(folder, 'empty.jpg') },
    { kind: 'photo', windowsPath: null },
  ]);
  assert.deepEqual(result.map(row => row.windowsResult), ['READ_OK', 'READ_OK', 'ENOENT', 'EMPTY_FILE', 'PATH_NOT_MAPPED']);
  assert.equal(fs.readFileSync(join(folder, 'ok.jpg'), 'utf8'), 'original');
});

test('summary groups matching project failures and retains a concrete example', () => {
  const summary = groupComparisons([1, 2, 3].map(id => ({ kind: 'photo', projectId: 'p1', linuxResult: 'ENOENT', windowsResult: 'READ_OK', path: `/nas/Projects/${id}.jpg`, windowsPath: `Z:\\Projects\\${id}.jpg` })));
  assert.equal(summary.length, 1);
  assert.equal(summary[0].count, 3);
  assert.equal(summary[0].exampleLinuxPath, '/nas/Projects/1.jpg');
});

test('native comparison child accepts UTF-8 paths through stdin and reads a bounded sample', context => {
  const folder = fs.mkdtempSync(join(tmpdir(), 'photolocal-porównanie-'));
  context.after(() => {
    assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const path = join(folder, 'zdjęcie.jpg');
  fs.writeFileSync(path, 'sample');
  const input = [{ kind: 'photo', projectId: 'p1', path: '/nas/Projects/zdjęcie.jpg', windowsPath: path, linuxResult: 'ENOENT' }];
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./diagnose-staging-copy.mjs', import.meta.url)), '--windows-check'], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 5000, windowsHide: true,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), [{ ...input[0], windowsResult: 'READ_OK' }]);
});

for (const [missingVolume, locate] of [[false, false], [true, false], [false, true]]) {
test(`diagnosis requires retained CIFS storage and can locate without Windows (missing=${missingVolume}, locate=${locate})`, async context => {
  const folder = fs.mkdtempSync(join(tmpdir(), 'photolocal-diagnose-'));
  context.after(() => {
    assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
    fs.rmSync(folder, { recursive: true, force: true });
  });
  fs.writeFileSync(join(folder, 'mapping.json'), JSON.stringify(mappings));
  fs.writeFileSync(join(folder, 'compose.staging-copy.json'), JSON.stringify({ services: { photolocal: { volumes: [
    { type: 'bind', source: 'C:/PhotoLocal/backend/zdjęcia', target: '/legacy-local-photos', read_only: true },
    { type: 'bind', source: 'C:/PhotoLocal/pobierzchat/pobrane_zdjecia', target: '/legacy-downloads', read_only: true },
  ] } }, volumes: { staging_nas: { external: true, name: 'photolocal-staging-nas-ab12' } } }));
  const calls = [];
  let nativeCalls = 0;
  const operation = diagnoseStagingCopy({ runDirectory: folder, windowsShare: locate ? undefined : '\\\\192.0.2.70\\Photos', locate }, {
    invoke: async args => {
      calls.push(args);
      if (args[0] === 'volume') {
        assert.equal(args[1], 'inspect');
        return missingVolume ? { code: 1, stdout: '', stderr: 'No such volume' }
          : { code: 0, stdout: 'photolocal-staging-nas-ab12|local|cifs\n', stderr: '' };
      }
      if (args[0] === 'container') return { code: 1, stdout: '', stderr: 'No such container' };
      assert.equal(args.includes('--locate'), locate);
      assert.ok(args.filter(arg => arg.startsWith('type=')).every(arg => arg.includes('readonly')));
      return { code: 1, stderr: 'must stay private', stdout: JSON.stringify({ status: 'STAGING_COPY_FILES_MISSING', counts: { projects: 1 }, projectFolders: { missing: 1 }, photoSamples: { unreadable: 0 }, failures: [{ kind: 'project_folder', projectId: 'p1', photoId: null, path: '/nas/Projects/Job', reason: 'ENOENT', ...(locate ? { location: { deepestDirectory: '/nas/Projects', firstMissingSegment: 'Job', reason: 'ENOENT', suggestions: ['JOB'] } } : {}) }], failuresTruncated: 0 }) };
    },
    nativeCheck: checks => { nativeCalls++; return checks.map(check => ({ ...check, windowsResult: 'READ_OK' })); },
  });
  if (missingVolume) {
    await assert.rejects(operation, { code: 'STAGING_STORAGE_VOLUME_MISSING' });
    assert.ok(calls.every(args => args[0] === 'volume' && args[1] === 'inspect'));
    return;
  }
  const report = await operation;
  assert.equal(report.status, 'STAGING_DIAGNOSIS_COMPLETE');
  if (locate) {
    assert.equal(nativeCalls, 0);
    assert.equal(report.locations[0].location.firstMissingSegment, 'Job');
    assert.deepEqual(report.locations[0].location.suggestions, ['JOB']);
    assert.equal(Object.hasOwn(report, 'comparisons'), false);
  } else {
    assert.equal(report.comparisons[0].windowsResult, 'READ_OK');
  }
  assert.ok(fs.existsSync(report.reportPath));
  assert.ok(!calls.some(args => (args[0] === 'volume' && args[1] !== 'inspect') || args[0] === 'compose'));
  assert.equal(JSON.stringify(report).includes('must stay private'), false);
});
}
