import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const revision = 'a'.repeat(40);
const imageId = 'sha256:' + 'b'.repeat(64);

function powershellLiteral(value) {
  return "'" + value.replaceAll("'", "''") + "'";
}

function runWrapper(context, scenario = {}) {
  const temporaryParent = realpathSync(tmpdir());
  const prefix = 'photolocal app updater ';
  const directory = mkdtempSync(join(temporaryParent, prefix));
  context.after(() => {
    const resolved = realpathSync(directory);
    assert.equal(dirname(resolved), temporaryParent);
    assert.ok(basename(resolved).startsWith(prefix));
    rmSync(resolved, { recursive: true, force: true });
  });
  const applicationRoot = join(
    directory,
    scenario.customPaths ? "Romka żółć ' $&! staged app" : 'PhotoLocal staged app',
  );
  const runDirectory = join(applicationRoot, 'docker-data', 'production-' + 'c'.repeat(32));
  const outsideDirectory = join(directory, 'unrelated production');
  mkdirSync(join(applicationRoot, 'scripts'), { recursive: true });
  mkdirSync(runDirectory, { recursive: true });
  mkdirSync(outsideDirectory);
  const helper = join(applicationRoot, 'scripts', 'update-production-app.mjs');
  writeFileSync(helper, 'old helper source');
  const configFiles = [
    join(runDirectory, 'compose.production.json'),
    join(runDirectory, 'chat-browser.override.json'),
  ];
  for (const path of configFiles) writeFileSync(path, '{}');
  if (scenario.outsideConfig) {
    const extra = join(outsideDirectory, 'compose.production.json');
    writeFileSync(extra, '{}');
    configFiles.push(extra);
  }
  const container = [
    {
      Id: 'd'.repeat(64),
      Name: scenario.wrongContainer ? '/another-app' : '/photolocal-production-photolocal-1',
      Config: {
        Labels: {
          'com.docker.compose.project': 'photolocal-production',
          'com.docker.compose.service': 'photolocal',
          'com.docker.compose.project.working_dir': runDirectory,
          'com.docker.compose.project.config_files': configFiles.join(','),
        },
      },
      State: { Running: true, Health: { Status: 'healthy' } },
    },
  ];
  const wrapper = join(directory, 'update-production-app.ps1');
  copyFileSync(join(scriptsDirectory, 'update-production-app.ps1'), wrapper);
  const runner = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    '. ' + powershellLiteral(wrapper),
    '$script:TestCalls = @()',
    '$script:TestScenario = ' + powershellLiteral(JSON.stringify(scenario)) + ' | ConvertFrom-Json',
    '$script:TestRoot = ' + powershellLiteral(applicationRoot),
    '$script:TestRun = ' + powershellLiteral(runDirectory),
    '$script:TestHelper = ' + powershellLiteral(helper),
    '$script:TestContainer = ' + powershellLiteral(JSON.stringify(container)),
    'function Get-PhotoLocalAppUpdateExecutable { param([string]$Name); return $Name }',
    'if (-not $script:TestScenario.realLock) {',
    'function Enter-PhotoLocalAppUpdateLock {',
    '  param([string]$RunDirectory)',
    '  $script:TestCalls += @{ executable = "lock-enter"; runDirectory = $RunDirectory }',
    '  if ($script:TestScenario.concurrent) { throw "PRODUCTION_APP_UPDATE_ALREADY_RUNNING" }',
    '  return @{ runDirectory = $RunDirectory }',
    '}',
    'function Exit-PhotoLocalAppUpdateLock {',
    '  param($Lock)',
    '  $script:TestCalls += @{ executable = "lock-exit"; runDirectory = $Lock.runDirectory }',
    '}',
    '}',
    'function Invoke-PhotoLocalAppUpdateProcess {',
    '  param([string]$Executable, [string[]]$Arguments, [string]$WorkingDirectory, [string]$InputText, [int]$TimeoutSeconds)',
    '  $call = @{ executable = $Executable; arguments = @($Arguments); workingDirectory = $WorkingDirectory }',
    '  if ($Executable -eq "node.exe") { $call.payload = $InputText | ConvertFrom-Json; $call.helperSource = [IO.File]::ReadAllText($Arguments[0]) }',
    '  $script:TestCalls += $call',
    '  if ($Executable -eq "docker.exe") {',
    '    if ($script:TestScenario.dockerFails) { return @{ ExitCode = 1; Stdout = ""; Stderr = "docker unavailable" } }',
    '    if ($Arguments[0] -eq "container") {',
    '      $name = if ($script:TestScenario.absent) { "" } else { "photolocal-production-photolocal-1" }',
    '      return @{ ExitCode = 0; Stdout = $name; Stderr = "" }',
    '    }',
    '    return @{ ExitCode = 0; Stdout = $script:TestContainer; Stderr = "" }',
    '  }',
    '  if ($Executable -eq "git.exe") {',
    '    if ($Arguments[2] -eq "status") {',
    '      $dirty = if ($script:TestScenario.dirty) { " M server-change.txt" } else { "" }',
    '      return @{ ExitCode = 0; Stdout = $dirty; Stderr = "" }',
    '    }',
    '    if ($Arguments[2] -eq "branch") {',
    '      $branch = if ($script:TestScenario.wrongBranch) { "codex/google-auth-docker" } else { "main" }',
    '      return @{ ExitCode = 0; Stdout = $branch; Stderr = "" }',
    '    }',
    '    if ($Arguments[2] -eq "pull") {',
    '      if ($script:TestScenario.pullFails) { return @{ ExitCode = 1; Stdout = ""; Stderr = "pull failed" } }',
    '      [IO.File]::WriteAllText($script:TestHelper, "post-pull helper source", [Text.Encoding]::UTF8)',
    '      return @{ ExitCode = 0; Stdout = ""; Stderr = "" }',
    '    }',
    '    $value = if ($Arguments -contains "--show-toplevel") { $script:TestRoot } elseif ($script:TestScenario.invalidRevision) { "invalid" } else { "' +
      revision +
      '" }',
    '    return @{ ExitCode = 0; Stdout = $value; Stderr = "" }',
    '  }',
    '  if ($Executable -eq "node.exe") {',
    '    if ($script:TestScenario.sourceChanged) {',
    '      $report = @{ status = "PRODUCTION_APP_UPDATE_FAILED"; code = "PRODUCTION_APP_UPDATE_SOURCE_CHANGED"; phase = "build"; applicationMayHaveChanged = $false } | ConvertTo-Json -Compress',
    '      return @{ ExitCode = 1; Stdout = $report; Stderr = "private ignored stderr" }',
    '    }',
    '    $status = if ($script:TestScenario.invalidReport) { "UNTRUSTED_PRIVATE_RESULT" } elseif ($script:TestScenario.prepareOnly) { "PRODUCTION_APP_PREPARED" } else { "PRODUCTION_APP_UPDATED" }',
    '    $report = @{ status = $status; runDirectory = $script:TestRun; previousImageId = "' +
      imageId +
      '"; imageId = "' +
      imageId +
      '"; revision = "' +
      revision +
      '"; applicationUpdated = -not [bool]$script:TestScenario.prepareOnly } | ConvertTo-Json -Compress',
    '    return @{ ExitCode = 0; Stdout = $report; Stderr = "" }',
    '  }',
    '  throw "Unexpected executable"',
    '}',
    '$requestedRun = if ($script:TestScenario.wrongRun) { ' +
      powershellLiteral(outsideDirectory) +
      ' } else { $script:TestRun }',
    '$rootInput = if ($script:TestScenario.rootDot) { $script:TestRoot + "\\." } else { $script:TestRoot }',
    '$result = Invoke-PhotoLocalProductionAppUpdate -ApplicationRoot $rootInput -RunDirectory $requestedRun -PrepareOnly:([bool]$script:TestScenario.prepareOnly)',
    '@{ result = $result; calls = @($script:TestCalls) } | ConvertTo-Json -Depth 12 -Compress',
  ].join('\r\n');
  const runnerPath = join(directory, 'runner.ps1');
  writeFileSync(runnerPath, '\uFEFF' + runner, 'utf8');
  const child = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runnerPath],
    {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'),
      ),
    },
  );
  assert.ok(!child.error, 'Mocked updater must complete within its timeout');
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim().replace(/^\uFEFF/, ''));
  return { ...result, applicationRoot, runDirectory, helper };
}

const windowsOnly = { skip: process.platform !== 'win32' };

test(
  'Windows production updater runs the freshly pulled MJS with the selected deployment paths',
  windowsOnly,
  (context) => {
    const report = runWrapper(context);
    assert.equal(report.result.status, 'PRODUCTION_APP_UPDATED');
    const gitCalls = report.calls.filter((call) => call.executable === 'git.exe');
    assert.ok(
      gitCalls.findIndex((call) => call.arguments[2] === 'status') <
        gitCalls.findIndex((call) => call.arguments[2] === 'pull'),
    );
    assert.ok(
      gitCalls
        .find((call) => call.arguments[2] === 'status')
        .arguments.includes('--untracked-files=no'),
    );
    const nodeCall = report.calls.find((call) => call.executable === 'node.exe');
    assert.deepEqual(nodeCall.arguments, [report.helper]);
    assert.equal(nodeCall.workingDirectory, report.applicationRoot);
    assert.equal(nodeCall.helperSource.trim().replace(/^\uFEFF/, ''), 'post-pull helper source');
    assert.deepEqual(nodeCall.payload, {
      stagingRoot: report.applicationRoot,
      runDirectory: report.runDirectory,
      revision,
      prepareOnly: false,
    });
    assert.ok(!report.calls.some((call) => /stop|start/.test(call.executable)));
  },
);

for (const [name, scenario, code] of [
  ['tracked local changes', { dirty: true }, 'PRODUCTION_APP_UPDATE_GIT_WORKTREE_NOT_CLEAN'],
  [
    'requested run outside the checkout',
    { wrongRun: true },
    'PRODUCTION_APP_UPDATE_INVALID_CONFIGURATION',
  ],
  [
    'any compose configuration outside the owned run',
    { outsideConfig: true },
    'PRODUCTION_APP_UPDATE_INVALID_CONFIGURATION',
  ],
  [
    'another container identity',
    { wrongContainer: true },
    'PRODUCTION_APP_UPDATE_CONTAINER_IDENTITY_INVALID',
  ],
  ['a failed Docker query', { dockerFails: true }, 'PRODUCTION_APP_UPDATE_DOCKER_QUERY_FAILED'],
]) {
  test(
    'Windows production updater refuses ' + name + ' before pulling code',
    windowsOnly,
    (context) => {
      const report = runWrapper(context, scenario);
      assert.equal(report.result.status, 'PRODUCTION_APP_UPDATE_FAILED');
      assert.equal(report.result.code, code);
      assert.ok(
        !report.calls.some((call) => call.executable === 'git.exe' && call.arguments[2] === 'pull'),
      );
      assert.ok(!report.calls.some((call) => call.executable === 'node.exe'));
    },
  );
}

test(
  'Windows production updater does not build after a failed fast-forward pull',
  windowsOnly,
  (context) => {
    const report = runWrapper(context, { pullFails: true });
    assert.equal(report.result.code, 'PRODUCTION_APP_UPDATE_GIT_PULL_FAILED');
    assert.equal(report.result.applicationMayHaveChanged, false);
    assert.ok(!report.calls.some((call) => call.executable === 'node.exe'));
  },
);

test(
  'Windows production updater distinguishes absent production from an unavailable Docker daemon',
  windowsOnly,
  (context) => {
    const report = runWrapper(context, { absent: true });
    assert.equal(report.result.status, 'PRODUCTION_APP_NOT_FOUND');
    assert.ok(!report.calls.some((call) => call.executable !== 'docker.exe'));
  },
);

test(
  'Windows production updater preserves custom paths and preparation-only intent',
  windowsOnly,
  (context) => {
    const report = runWrapper(context, { customPaths: true, prepareOnly: true });
    assert.equal(report.result.status, 'PRODUCTION_APP_PREPARED');
    const nodeCall = report.calls.find((call) => call.executable === 'node.exe');
    assert.equal(nodeCall.payload.stagingRoot, report.applicationRoot);
    assert.equal(nodeCall.payload.runDirectory, report.runDirectory);
    assert.equal(nodeCall.payload.prepareOnly, true);
  },
);

test(
  'Windows production updater rejects an invalid revision before loading the helper',
  windowsOnly,
  (context) => {
    const report = runWrapper(context, { invalidRevision: true });
    assert.equal(report.result.code, 'PRODUCTION_APP_UPDATE_GIT_REVISION_INVALID');
    assert.ok(!report.calls.some((call) => call.executable === 'node.exe'));
  },
);

test('Windows production updater suppresses an invalid child report', windowsOnly, (context) => {
  const report = runWrapper(context, { invalidReport: true });
  assert.equal(report.result.code, 'PRODUCTION_APP_UPDATE_CHILD_REPORT_INVALID');
  assert.ok(!JSON.stringify(report.result).includes('UNTRUSTED_PRIVATE_RESULT'));
});

test(
  'Windows production updater refuses a concurrent update before git pull',
  windowsOnly,
  (context) => {
    const report = runWrapper(context, { concurrent: true });
    assert.equal(report.result.code, 'PRODUCTION_APP_UPDATE_ALREADY_RUNNING');
    assert.ok(!report.calls.some((call) => call.executable === 'git.exe'));
    assert.ok(!report.calls.some((call) => call.executable === 'node.exe'));
  },
);

test(
  'Windows production updater releases its update lock after a failed pull',
  windowsOnly,
  (context) => {
    const report = runWrapper(context, { pullFails: true });
    assert.equal(report.calls.at(-1).executable, 'lock-exit');
    assert.equal(report.calls.at(-1).runDirectory, report.runDirectory);
  },
);

test(
  'Windows production updater preserves the validated child source-change failure',
  windowsOnly,
  (context) => {
    const report = runWrapper(context, { sourceChanged: true });
    assert.equal(report.result.code, 'PRODUCTION_APP_UPDATE_SOURCE_CHANGED');
    assert.equal(report.result.phase, 'build');
    assert.equal(report.result.applicationMayHaveChanged, false);
    assert.equal(report.calls.at(-1).executable, 'lock-exit');
    assert.ok(!JSON.stringify(report.result).includes('private ignored stderr'));
  },
);

test(
  'Windows production updater acquires and disposes the real Windows mutex around mocked processes',
  windowsOnly,
  (context) => {
    const report = runWrapper(context, { realLock: true });
    assert.equal(report.result.status, 'PRODUCTION_APP_UPDATED');
    assert.ok(report.calls.some((call) => call.executable === 'node.exe'));
  },
);

test(
  'Windows production updater canonicalizes an explicit application root ending in dot',
  windowsOnly,
  (context) => {
    const report = runWrapper(context, { rootDot: true });
    assert.equal(report.result.status, 'PRODUCTION_APP_UPDATED');
    assert.equal(
      report.calls.find((call) => call.executable === 'node.exe').payload.stagingRoot,
      report.applicationRoot,
    );
  },
);

test(
  'Windows production updater requires main before pulling or starting the updater',
  windowsOnly,
  (context) => {
    const report = runWrapper(context, { wrongBranch: true });
    assert.equal(report.result.code, 'PRODUCTION_APP_UPDATE_WRONG_BRANCH');
    assert.equal(report.result.phase, 'preflight');
    assert.equal(report.result.applicationMayHaveChanged, false);
    const gitCalls = report.calls.filter((call) => call.executable === 'git.exe');
    const branchCall = gitCalls.find((call) => call.arguments[2] === 'branch');
    assert.deepEqual(branchCall.arguments, [
      '-C',
      report.applicationRoot,
      'branch',
      '--show-current',
    ]);
    assert.ok(
      gitCalls.findIndex((call) => call.arguments[2] === 'status') < gitCalls.indexOf(branchCall),
    );
    assert.ok(!gitCalls.some((call) => call.arguments[2] === 'pull'));
    assert.ok(!report.calls.some((call) => call.executable === 'node.exe'));
  },
);

test(
  'Windows batch bootstrap survives inherited delayed expansion and a replaced batch file',
  windowsOnly,
  (context) => {
    const temporaryParent = realpathSync(tmpdir());
    const prefix = 'photolocal ! updater bootstrap ';
    const directory = mkdtempSync(join(temporaryParent, prefix));
    context.after(() => {
      const resolved = realpathSync(directory);
      assert.equal(dirname(resolved), temporaryParent);
      assert.ok(basename(resolved).startsWith(prefix));
      rmSync(resolved, { recursive: true, force: true });
    });
    mkdirSync(join(directory, 'scripts'));
    copyFileSync(join(scriptsDirectory, '..', 'update.bat'), join(directory, 'update.bat'));
    const fakeRunner = [
      'param([string]$ApplicationRoot = (Split-Path -Parent $PSScriptRoot))',
      'if ($PSBoundParameters.ContainsKey("ApplicationRoot")) { exit 9 }',
      '[IO.File]::WriteAllText((Join-Path $ApplicationRoot "bootstrap-root.txt"), $ApplicationRoot)',
      '[IO.File]::WriteAllText((Join-Path $ApplicationRoot "update.bat"), "rem overwritten while the child runs")',
      'exit 0',
    ].join('\r\n');
    writeFileSync(
      join(directory, 'scripts', 'update-production-app.ps1'),
      '\uFEFF' + fakeRunner,
      'utf8',
    );
    const child = spawnSync('cmd.exe', ['/d', '/v:on', '/s', '/c', 'update.bat'], {
      cwd: directory,
      encoding: 'utf8',
      input: '\r\n',
      timeout: 30_000,
      windowsHide: true,
    });
    assert.ok(!child.error, 'Batch bootstrap must complete within its timeout');
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.equal(readFileSync(join(directory, 'bootstrap-root.txt'), 'utf8'), directory);
  },
);
