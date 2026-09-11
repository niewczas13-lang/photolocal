import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildProductionConfiguration } from './production-deployment-config.mjs';
import { buildChatBrowserOverride, verifyChatBrowserMerge, updateChatBrowser, PROFILE_VOLUME } from './update-chat-browser.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const image = letter => `sha256:${letter.repeat(64)}`;
const originalImage = image('a');
const mainImage = image('b');
const browserImage = image('c');
const appId = 'd'.repeat(64);
const browserId = 'e'.repeat(64);
const windows = { skip: process.platform !== 'win32' };
const decode = value => value.replaceAll('$$', '$');
function merged(before, override) {
  const after = structuredClone(before);
  after.services.photolocal.image = override.services.photolocal.image;
  Object.assign(after.services.photolocal.environment, override.services.photolocal.environment);
  after.services['chat-browser'] = structuredClone(override.services['chat-browser']);
  after.volumes.chat_browser_profile = structuredClone(override.volumes.chat_browser_profile);
  return after;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'photolocal-browser-update-'));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.match(root.split(/[\\/]/).at(-1), /^photolocal-browser-update-/);
    await rm(root, { recursive: true, force: true });
  });
  const stagingRoot = join(root, 'staging');
  const runDirectory = join(stagingRoot, 'docker-data', `production-${'f'.repeat(32)}`);
  for (const folder of ['data', 'google', 'downloads', 'local-photos', 'photos']) {
    await mkdir(join(runDirectory, folder), { recursive: true });
    await writeFile(join(runDirectory, folder, 'sentinel'), `preserve ${folder}`);
  }
  const base = buildProductionConfiguration({
    productionRoot: join(root, 'native'), stagingRoot, runDirectory,
    networkPrefix: 'Z:\\__BELL', imageId: originalImage, publicUrl: 'https://romek.example.test',
    sourceEnvironment: { ADRESY_APP_API_KEY: 'literal$secret${TOKEN}', OLLAMA_URL: 'http://host.docker.internal:11434' },
    storage: { version: 2, accessMode: 'rw', containerPath: '/nas', subdirectory: '__BELL', volumeName: `photolocal-production-nas-${'1'.repeat(32)}` },
  }).compose;
  base.networks = { default: { name: 'photolocal-production_default' } };
  base.services.photolocal.networks = { default: null };
  const files = [join(runDirectory, 'compose.production.json'), join(runDirectory, 'compose.previous-fix.json')];
  await writeFile(files[0], JSON.stringify(base));
  await writeFile(files[1], JSON.stringify({ services: { photolocal: { image: originalImage } } }));
  await writeFile(join(runDirectory, 'empty.env'), '');
  const labels = service => ({
    'com.docker.compose.project': 'photolocal-production', 'com.docker.compose.service': service,
    'com.docker.compose.project.working_dir': runDirectory,
    'com.docker.compose.project.config_files': files.join(','),
  });
  const app = { id: appId, image: originalImage, labels: labels('photolocal'),
    state: { Status: 'running', Health: { Status: 'healthy' } },
    environment: Object.entries(base.services.photolocal.environment).map(([key, value]) => `${key}=${decode(value)}`),
    mounts: base.services.photolocal.volumes.map(mount => ({ Type: mount.type, Destination: mount.target, RW: true,
      ...(mount.type === 'bind' ? { Source: decode(mount.source) } : { Name: base.volumes[mount.source].name }) })),
  };
  const browser = { id: browserId, image: browserImage, labels: labels('chat-browser'),
    state: { Status: 'running', Health: { Status: 'healthy' } },
    mounts: [{ Type: 'volume', Destination: '/profile', Name: PROFILE_VOLUME, RW: true }],
    host: { ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], PortBindings: {}, ShmSize: 268435456,
      NetworkMode: 'photolocal-production_default', Tmpfs: { '/tmp': 'mode=1777,size=512m' } },
    user: '1000:1000',
    networks: { 'photolocal-production_default': {} },
  };
  let browserStarted = false;
  const calls = [];
  const control = {};
  const run = async (executable, args) => {
    calls.push({ executable, args });
    assert.equal(executable, 'docker');
    const okay = stdout => ({ code: 0, stdout, stderr: '' });
    if (args[0] === 'ps') return okay(args.some(value => value.includes('service=chat-browser')) ? (browserStarted ? browserId : '') : appId);
    if (args[0] === 'container' && args[1] === 'inspect') return okay(JSON.stringify(args.at(-1) === browserId ? browser : app));
    if (args[0] === 'volume') return browserStarted || control.foreignVolume || control.profileOptions
      ? okay(JSON.stringify({ labels: { 'com.docker.compose.project': control.foreignVolume ? 'foreign' : 'photolocal-production',
        'com.docker.compose.volume': 'chat_browser_profile' }, driver: 'local', scope: 'local',
        options: control.profileOptions ? { type: 'cifs', device: '//private/share' } : null }))
      : { code: 1, stdout: '', stderr: 'no such volume' };
    if (args[0] === 'build') return okay('PRIVATE_BUILD_OUTPUT');
    if (args[0] === 'image') return okay(args.at(-1).startsWith('photolocal-chat-browser:') ? browserImage : mainImage);
    assert.equal(args[0], 'compose');
    const configFiles = args.flatMap((value, index) => value === '-f' ? [args[index + 1]] : []);
    const override = configFiles.length > files.length ? JSON.parse(await readFile(configFiles.at(-1), 'utf8')) : null;
    if (args.includes('config')) {
      const config = override ? merged(base, override) : base;
      if (override && control.tamperMerge) config.services.photolocal.volumes[0].source = 'C:/wrong/data';
      return okay(JSON.stringify(config));
    }
    assert.ok(args.includes('up'));
    if (args.at(-1) === 'chat-browser') {
      if (control.failBrowser) return { code: 1, stdout: '', stderr: 'PRIVATE_BROWSER_SECRET' };
      browserStarted = true;
      if (control.changeActive) app.image = image('9');
      if (control.privilegedBrowser) browser.host.Privileged = true;
    } else {
      assert.equal(args.at(-1), 'photolocal');
      app.image = override ? mainImage : originalImage;
      app.labels['com.docker.compose.project.config_files'] = configFiles.join(',');
      app.environment = Object.entries(base.services.photolocal.environment).map(([key, value]) => `${key}=${decode(value)}`);
      if (override) for (const [key, value] of Object.entries(override.services.photolocal.environment)) {
        app.environment = app.environment.filter(entry => !entry.startsWith(`${key}=`)); app.environment.push(`${key}=${value}`);
      }
      if (control.failApp) { app.state.Status = 'exited'; return { code: 1, stdout: '', stderr: 'PRIVATE_APP_SECRET' }; }
      app.state.Status = 'running';
    }
    return okay('');
  };
  return { root, input: { stagingRoot, runDirectory, workStopped: true }, base, files, app, calls, control, run };
}

test('override isolates the persistent browser and does not weaken its sandbox by default', () => {
  const value = buildChatBrowserOverride({ imageId: mainImage, browserImageId: browserImage });
  assert.deepEqual(Object.keys(value.services.photolocal).sort(), ['environment', 'image']);
  const browser = value.services['chat-browser'];
  assert.equal(browser.user, '1000:1000');
  assert.equal(browser.read_only, true);
  assert.deepEqual(browser.cap_drop, ['ALL']);
  assert.deepEqual(browser.security_opt, ['no-new-privileges:true']);
  assert.equal(browser.ports, undefined);
  assert.equal(browser.environment.CHAT_BROWSER_DISABLE_SANDBOX, 'false');
  assert.deepEqual(browser.volumes, [{ type: 'volume', source: 'chat_browser_profile', target: '/profile' }]);
  assert.equal(value.volumes.chat_browser_profile.name, PROFILE_VOLUME);
  assert.equal(buildChatBrowserOverride({ imageId: mainImage, browserImageId: browserImage, disableSandbox: true })
    .services['chat-browser'].environment.CHAT_BROWSER_DISABLE_SANDBOX, 'true');
  assert.throws(() => buildChatBrowserOverride({ imageId: 'latest', browserImageId: browserImage }), { code: 'CHAT_BROWSER_UPDATE_INVALID_IMAGE' });
});

test('default update preserves literal dollars, current files and data while starting browser before app', windows, async t => {
  const f = await fixture(t);
  const report = await updateChatBrowser(f.input, { run: f.run });
  assert.equal(report.status, 'CHAT_BROWSER_UPDATED');
  assert.equal(report.url, 'https://romek.example.test');
  const starts = f.calls.filter(call => call.args.includes('up'));
  assert.deepEqual(starts.map(call => call.args.at(-1)), ['chat-browser', 'photolocal']);
  assert.ok(starts[1].args.includes('--force-recreate'));
  for (const start of starts) assert.deepEqual(start.args.flatMap((value, index) => value === '-f' ? [start.args[index + 1]] : []).slice(0, 2), f.files);
  for (const folder of ['data', 'google', 'downloads', 'local-photos', 'photos']) {
    assert.equal(await readFile(join(f.input.runDirectory, folder, 'sentinel'), 'utf8'), `preserve ${folder}`);
  }
  assert.ok(f.app.environment.includes('ADRESY_APP_API_KEY=literal$secret${TOKEN}'));
  assert.ok(!JSON.stringify(report).includes('secret'));
  assert.equal(f.calls.filter(call => call.args[0] === 'build').length, 2);
});

test('PrepareOnly checks the browser without touching the running app', windows, async t => {
  const f = await fixture(t);
  const report = await updateChatBrowser({ ...f.input, workStopped: false, prepareOnly: true }, { run: f.run });
  assert.equal(report.status, 'CHAT_BROWSER_PREPARED');
  assert.equal(f.app.image, originalImage);
  assert.deepEqual(f.calls.filter(call => call.args.includes('up')).map(call => call.args.at(-1)), ['chat-browser']);
});

test('changing Docker inspect mount order preserves update and rollback on the same data', windows, async t => {
  const f = await fixture(t);
  let inspection = 0;
  const run = async (executable, args) => {
    const result = await f.run(executable, args);
    if (args[0] !== 'container' || args[1] !== 'inspect' || args.at(-1) !== appId) return result;
    const app = JSON.parse(result.stdout);
    const offset = ++inspection % app.mounts.length;
    app.mounts = [...app.mounts.slice(offset), ...app.mounts.slice(0, offset)];
    return { ...result, stdout: JSON.stringify(app) };
  };
  const prepared = await updateChatBrowser({ ...f.input, prepareOnly: true, disableSandbox: true }, { run });
  assert.equal(prepared.status, 'CHAT_BROWSER_PREPARED');
  assert.equal(f.app.image, originalImage);
  const updated = await updateChatBrowser({ ...f.input, disableSandbox: true }, { run });
  assert.equal(updated.status, 'CHAT_BROWSER_UPDATED');
  const restored = await updateChatBrowser({ ...f.input, rollbackReport: updated.rollbackReport }, { run });
  assert.equal(restored.status, 'CHAT_BROWSER_ROLLED_BACK');
  assert.equal(f.app.image, originalImage);
  for (const folder of ['data', 'google', 'downloads', 'local-photos', 'photos']) {
    assert.equal(await readFile(join(f.input.runDirectory, folder, 'sentinel'), 'utf8'), `preserve ${folder}`);
  }
});

test('mount reordering never hides a changed source, permission, volume, or destination', windows, async t => {
  for (const change of ['source', 'permission', 'volume', 'type', 'destination', 'removed', 'duplicate']) {
    const f = await fixture(t);
    let inspection = 0;
    const run = async (executable, args) => {
      const result = await f.run(executable, args);
      if (args[0] !== 'container' || args[1] !== 'inspect' || args.at(-1) !== appId) return result;
      const app = JSON.parse(result.stdout);
      if (++inspection > 1) {
        const data = app.mounts.find(mount => mount.Destination === '/data');
        if (change === 'source') data.Source = 'C:/different/data';
        if (change === 'permission') data.RW = false;
        if (change === 'type') data.Type = 'volume';
        if (change === 'volume') app.mounts.find(mount => mount.Destination === '/nas').Name = 'different-volume';
        if (change === 'destination') data.Destination = '/different-data';
        if (change === 'removed') app.mounts.pop();
        if (change === 'duplicate') app.mounts.push({ ...data });
        app.mounts.reverse();
      }
      return { ...result, stdout: JSON.stringify(app) };
    };
    await assert.rejects(updateChatBrowser({ ...f.input, prepareOnly: true }, { run }), {
      code: 'CHAT_BROWSER_UPDATE_ACTIVE_CONFIGURATION_CHANGED', applicationMayHaveChanged: false,
    });
    assert.ok(!f.calls.some(call => call.args.includes('up')));
  }
});

test('malformed, missing or out-of-run Compose paths cannot authorize an update', windows, async t => {
  for (const invalid of ['C:\\outside\\compose.json', join(tmpdir(), 'missing.json'), `${'C:\\safe'}\ncompose.json`]) {
    const f = await fixture(t);
    f.app.labels['com.docker.compose.project.config_files'] = invalid;
    await assert.rejects(updateChatBrowser(f.input, { run: f.run }), { code: 'CHAT_BROWSER_UPDATE_INVALID_CONFIGURATION' });
    assert.ok(!f.calls.some(call => call.args[0] === 'build' || call.args.includes('up')));
  }
});

test('unsafe merge or foreign profile volume fails before any service is changed', windows, async t => {
  for (const option of ['tamperMerge', 'foreignVolume', 'profileOptions']) {
    const f = await fixture(t); f.control[option] = true;
    await assert.rejects(updateChatBrowser(f.input, { run: f.run }));
    assert.ok(!f.calls.some(call => call.args.includes('up')));
  }
});

test('browser startup failure and changed active app never proceed to app recreation', windows, async t => {
  for (const option of ['failBrowser', 'changeActive', 'privilegedBrowser']) {
    const f = await fixture(t); f.control[option] = true;
    await assert.rejects(updateChatBrowser(f.input, { run: f.run }), error => {
      assert.match(error.code, /^CHAT_BROWSER_/);
      assert.ok(!JSON.stringify(error).includes('PRIVATE_BROWSER_SECRET'));
      assert.equal(error.applicationMayHaveChanged, false);
      return true;
    });
    assert.ok(!f.calls.some(call => call.args.includes('up') && call.args.at(-1) === 'photolocal'));
  }
});

test('failed application recreation retains a nonsecret recovery report and explicit rollback uses the same data', windows, async t => {
  const f = await fixture(t); f.control.failApp = true;
  let recovery;
  await assert.rejects(updateChatBrowser(f.input, { run: f.run }), error => {
    assert.equal(error.applicationMayHaveChanged, true);
    assert.equal(error.code, 'CHAT_BROWSER_UPDATE_APP_START_FAILED');
    recovery = error.rollbackReport;
    assert.ok(recovery); return true;
  });
  assert.equal(f.app.state.Status, 'exited');
  const reportText = await readFile(recovery, 'utf8');
  assert.ok(!reportText.includes('secret'));
  f.control.failApp = false;
  const report = await updateChatBrowser({ ...f.input, rollbackReport: recovery }, { run: f.run });
  assert.equal(report.status, 'CHAT_BROWSER_ROLLED_BACK');
  assert.equal(f.app.image, originalImage);
  assert.equal(f.app.labels['com.docker.compose.project.config_files'], f.files.join(','));
  assert.ok(f.app.environment.includes('ADRESY_APP_API_KEY=literal$secret${TOKEN}'));
  for (const folder of ['data', 'google', 'downloads', 'local-photos', 'photos']) {
    assert.equal(await readFile(join(f.input.runDirectory, folder, 'sentinel'), 'utf8'), `preserve ${folder}`);
  }
});

test('actual offline Compose merge retains dollars and adds no browser host ports', windows, async t => {
  const f = await fixture(t);
  const version = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', windowsHide: true });
  if (version.status !== 0) return t.skip('Docker Compose CLI unavailable; no engine is needed.');
  const override = buildChatBrowserOverride({ imageId: mainImage, browserImageId: browserImage });
  const overridePath = join(f.input.runDirectory, 'compose.chat-browser-test.json');
  await writeFile(overridePath, JSON.stringify(override));
  const args = ['compose', '-p', 'photolocal-production', '--project-directory', f.input.runDirectory,
    '--env-file', join(f.input.runDirectory, 'empty.env'), '-f', f.files[0], '-f', f.files[1]];
  const before = spawnSync('docker', [...args, 'config', '--format', 'json'], { encoding: 'utf8', windowsHide: true });
  const after = spawnSync('docker', [...args, '-f', overridePath, 'config', '--format', 'json'], { encoding: 'utf8', windowsHide: true });
  assert.equal(before.status, 0, before.stderr);
  assert.equal(after.status, 0, after.stderr);
  const rendered = JSON.parse(after.stdout);
  verifyChatBrowserMerge(JSON.parse(before.stdout), rendered, override);
  assert.equal(rendered.services['chat-browser'].ports, undefined);
  assert.equal(decode(rendered.services.photolocal.environment.ADRESY_APP_API_KEY), 'literal$secret${TOKEN}');
});

test('repeated browser updates and rollback use real Compose without duplicating security settings', windows, async t => {
  const f = await fixture(t);
  const version = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', windowsHide: true });
  if (version.status !== 0) return t.skip('Docker Compose CLI unavailable; no engine is needed.');
  const installed = buildChatBrowserOverride({ imageId: originalImage, browserImageId: browserImage, disableSandbox: true });
  const installedPath = join(f.input.runDirectory, 'compose.chat-browser-installed.json');
  await writeFile(installedPath, JSON.stringify(installed));
  f.files.push(installedPath);
  Object.assign(f.base, merged(f.base, installed));
  f.app.labels['com.docker.compose.project.config_files'] = f.files.join(',');
  f.app.environment = Object.entries(f.base.services.photolocal.environment).map(([key, value]) => `${key}=${decode(value)}`);
  const originalFiles = await Promise.all(f.files.map(path => readFile(path, 'utf8')));
  const rendered = [];
  let composeError = '';
  const run = async (executable, args) => {
    if (args[0] !== 'compose' || !args.includes('config')) return f.run(executable, args);
    f.calls.push({ executable, args });
    const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) composeError = result.stderr;
    else rendered.push(JSON.parse(result.stdout));
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const first = await updateChatBrowser({ ...f.input, disableSandbox: true }, { run })
    .catch(error => assert.fail(`${error.code}: ${composeError}`));
  const second = await updateChatBrowser({ ...f.input, disableSandbox: true }, { run });
  for (const report of [first, second]) {
    assert.equal(report.status, 'CHAT_BROWSER_UPDATED');
    const delta = JSON.parse(await readFile(report.overridePath, 'utf8'));
    assert.deepEqual(Object.keys(delta.services['chat-browser']).sort(), ['environment', 'image']);
    assert.equal(delta.volumes, undefined);
  }
  assert.equal(f.app.labels['com.docker.compose.project.config_files'], [...f.files, first.overridePath, second.overridePath].join(','));
  const restored = await updateChatBrowser({ ...f.input, rollbackReport: second.rollbackReport }, { run });
  assert.equal(restored.status, 'CHAT_BROWSER_ROLLED_BACK');
  assert.equal(f.app.labels['com.docker.compose.project.config_files'], [...f.files, first.overridePath].join(','));
  assert.deepEqual(await Promise.all(f.files.map(path => readFile(path, 'utf8'))), originalFiles);
  for (const config of rendered) {
    assert.deepEqual(config.services['chat-browser'].security_opt, ['no-new-privileges:true']);
    assert.deepEqual(config.services['chat-browser'].tmpfs, ['/tmp:mode=1777,size=512m']);
    assert.equal(config.services['chat-browser'].environment.CHAT_BROWSER_DISABLE_SANDBOX, 'true');
    assert.equal(config.services['chat-browser'].ports, undefined);
    assert.equal(config.volumes.chat_browser_profile.name, PROFILE_VOLUME);
    assert.equal(decode(config.services.photolocal.environment.ADRESY_APP_API_KEY), 'literal$secret${TOKEN}');
    assert.deepEqual(config.services.photolocal.volumes, rendered[0].services.photolocal.volumes);
  }
  for (const folder of ['data', 'google', 'downloads', 'local-photos', 'photos']) {
    assert.equal(await readFile(join(f.input.runDirectory, folder, 'sentinel'), 'utf8'), `preserve ${folder}`);
  }
});

test('PowerShell 5 coordinator pulls first and sanitizes child failures without changing data', windows, async t => {
  const f = await fixture(t);
  await mkdir(join(f.input.stagingRoot, 'scripts'));
  await writeFile(join(f.input.stagingRoot, 'scripts', 'update-chat-browser.mjs'), '// isolated fixture');
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const script = `
$ErrorActionPreference = 'Stop'
. ${quote(join(repo, 'scripts', 'update-chat-browser.ps1'))}
$script:PhotoLocalChatUpdateRoot = ${quote(f.input.stagingRoot)}
function Get-PhotoLocalDeploymentIdentity { @{ Sid = 'S-1-5-21-test'; Owners = @('S-1-5-21-test') } }
function Assert-PhotoLocalDeploymentDirectory { param($Path) $Path }
function Assert-PhotoLocalNativeRunDirectory { param($RunDirectory, $StagingRoot, $ExpectedSid) $RunDirectory }
$script:calls = New-Object Collections.Generic.List[string]
$script:mode = 'okay'
function Invoke-PhotoLocalCutoverProcess {
  param($Executable, $Arguments, $WorkingDirectory, $InputText, $TimeoutSeconds)
  $script:calls.Add(($Arguments -join ' '))
  if ($Arguments -contains 'status') { return @{ ExitCode = 0; Stdout = ''; Stderr = '' } }
  if ($Arguments -contains 'pull') { return @{ ExitCode = 0; Stdout = 'PRIVATE_GIT_URL'; Stderr = '' } }
  if ($script:mode -eq 'bad') { return @{ ExitCode = 1; Stdout = 'PRIVATE_TOKEN'; Stderr = 'PRIVATE_SECRET' } }
  $payload = $InputText | ConvertFrom-Json
  if (-not $payload.workStopped -or $payload.prepareOnly -or $payload.disableSandbox) { throw 'BAD_PAYLOAD' }
  if ($script:mode -eq 'rollback') {
    if ($payload.rollbackReport -cne ${quote(join(f.input.runDirectory, `chat-browser-rollback-${'7'.repeat(32)}.json`))}) { throw 'BAD_ROLLBACK_PAYLOAD' }
    return @{ ExitCode = 0; Stdout = '{"status":"CHAT_BROWSER_ROLLED_BACK","url":"https://romek.example.test","applicationUpdated":true}'; Stderr = '' }
  }
  @{ ExitCode = 0; Stdout = '{"status":"CHAT_BROWSER_UPDATED","url":"https://romek.example.test","applicationUpdated":true,"sandboxEnabled":true}'; Stderr = '' }
}
$ok = Invoke-PhotoLocalChatBrowserUpdate -RunDirectory ${quote(f.input.runDirectory)} -WorkStopped
if ($ok.status -cne 'CHAT_BROWSER_UPDATED' -or $script:calls.Count -ne 3 -or $script:calls[1] -notmatch 'pull --ff-only') { throw 'ORDER_INVALID' }
$script:mode = 'bad'
$bad = Invoke-PhotoLocalChatBrowserUpdate -RunDirectory ${quote(f.input.runDirectory)} -WorkStopped
if ($bad.status -cne 'CHAT_BROWSER_UPDATE_FAILED' -or $bad.code -cne 'CHAT_BROWSER_UPDATE_CHILD_REPORT_INVALID' -or -not $bad.applicationMayHaveChanged) { throw 'REDACTION_INVALID' }
$script:calls.Clear()
$blocked = Invoke-PhotoLocalChatBrowserUpdate -RunDirectory ${quote(f.input.runDirectory)}
if ($blocked.code -cne 'CHAT_BROWSER_UPDATE_WORK_STOPPED_REQUIRED' -or $script:calls.Count -ne 0) { throw 'BOUNDARY_INVALID' }
$script:mode = 'rollback'
$restored = Invoke-PhotoLocalChatBrowserUpdate -RunDirectory ${quote(f.input.runDirectory)} -WorkStopped -RollbackReport ${quote(join(f.input.runDirectory, `chat-browser-rollback-${'7'.repeat(32)}.json`))}
if ($restored.status -cne 'CHAT_BROWSER_ROLLED_BACK' -or $script:calls.Count -ne 1 -or $script:calls[0] -notmatch 'update-chat-browser.mjs') { throw 'ROLLBACK_ORDER_INVALID' }
'PS5_COORDINATOR_OK'
`;
  const scriptPath = join(f.root, 'coordinator-test.ps1');
  await writeFile(scriptPath, script);
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PS5_COORDINATOR_OK/);
  assert.ok(!result.stdout.includes('PRIVATE_'));
});
