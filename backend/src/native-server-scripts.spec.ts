import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface ProcessFixture {
  id: number;
  name?: string;
  command?: 'own' | 'relative' | 'other' | 'missing';
  hasChangedIdentity?: boolean;
}

const stopScript = realpathSync.native(new URL('../../scripts', import.meta.url)) + '/stop-native-server.ps1';
const startScript = realpathSync.native(new URL('../../scripts', import.meta.url)) + '/start-native-server.ps1';

function runFixture(action: 'stop' | 'start', processes: ProcessFixture[]): Record<string, unknown> {
  const temporaryParent = realpathSync.native(tmpdir());
  const fixturePath = realpathSync.native(mkdtempSync(join(temporaryParent, 'photolocal-native-test-')));
  const root = join(fixturePath, 'PhotoLocal ! (test)');
  mkdirSync(join(root, 'backend', 'dist'), { recursive: true });
  writeFileSync(join(root, 'backend', 'dist', 'server.js'), '');
  const serverPath = realpathSync.native(join(root, 'backend', 'dist', 'server.js'));
  const harness = [
    "$ErrorActionPreference = 'Stop'",
    '. $env:PHOTOLOCAL_STOP_HELPER',
    ...(action === 'start' ? ['. $env:PHOTOLOCAL_START_HELPER'] : []),
    '$events = [Collections.Generic.List[string]]::new()',
    '$fixtures = ConvertFrom-Json $env:PHOTOLOCAL_PROCESSES',
    '$root = $env:PHOTOLOCAL_FIXTURE_ROOT',
    '$script:fixtureServerPath = $env:PHOTOLOCAL_FIXTURE_SERVER',
    '$stamp = [datetime]::Parse("2026-10-08T12:00:00Z").ToUniversalTime()',
    'function Get-NetTCPConnection { param($State, $LocalPort, $ErrorAction)',
    '  if ($LocalPort -ne 4873 -or $State -ne "Listen") { throw "Wrong listener query" }',
    '  foreach ($fixture in $fixtures) { [pscustomobject]@{ OwningProcess = $fixture.id } }',
    '}',
    'function Get-CimInstance { param($ClassName, $Filter, $ErrorAction)',
    '  $id = [int]($Filter -replace "[^0-9]", "")',
    '  $fixture = $fixtures | Where-Object { $_.id -eq $id } | Select-Object -First 1',
    '  $events.Add("inspect:$id")',
    '  $name = if ($fixture.name) { $fixture.name } else { "node.exe" }',
    '  $argument = switch ($fixture.command) {',
    '    "relative" { "dist/server.js" }; "other" { "C:\\AnotherApp\\backend\\dist\\server.js" };',
    '    "missing" { "" }; default { "`"$script:fixtureServerPath`"" }',
    '  }',
    '  [pscustomobject]@{ ProcessId=$id; Name=$name; ExecutablePath="C:\\Node\\node.exe";',
    '    CommandLine="C:\\Node\\node.exe $argument"; CreationDate=$stamp }',
    '}',
    'function Get-Process { param($Id, $ErrorAction)',
    '  $fixture = $fixtures | Where-Object { $_.id -eq $Id } | Select-Object -First 1',
    '  $startTime = if ($fixture.hasChangedIdentity) { $stamp.AddSeconds(30) } else { $stamp }',
    '  [pscustomobject]@{ Id=$Id; StartTime=$startTime }',
    '}',
    'function Stop-Process { param($InputObject, $ErrorAction)',
    '  $events.Add("stop:" + $InputObject.Id)',
    '}',
    'function Start-Process { param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle,',
    '  $RedirectStandardOutput, $RedirectStandardError, [switch]$PassThru, $ErrorAction)',
    '  $script:started = @{ argument=$ArgumentList; workingDirectory=$WorkingDirectory; windowStyle=$WindowStyle }',
    '  $events.Add("start")',
    '  [pscustomobject]@{ HasExited=$false; Id=123 }',
    '}',
    '$failure = $null',
    'try {',
    action === 'stop' ? '  Stop-PhotoLocalNativeServer -Root $root' : '  Start-PhotoLocalNativeServer -Root $root',
    '} catch { $failure = $_.Exception.Message }',
    '@{ events=@($events); failure=$failure; started=$started; server=$script:fixtureServerPath; root=$root } | ConvertTo-Json -Compress -Depth 5',
  ].join('\r\n');
  const harnessPath = join(fixturePath, 'harness.ps1');
  writeFileSync(harnessPath, harness);
  try {
    return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', harnessPath], {
      encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, PHOTOLOCAL_STOP_HELPER: stopScript, PHOTOLOCAL_START_HELPER: startScript,
        PHOTOLOCAL_FIXTURE_ROOT: root, PHOTOLOCAL_FIXTURE_SERVER: serverPath,
        PHOTOLOCAL_PROCESSES: JSON.stringify(processes) },
    }).trim()) as Record<string, unknown>;
  } finally {
    const resolvedFixture = realpathSync.native(fixturePath);
    if (dirname(resolvedFixture) !== temporaryParent || !basename(resolvedFixture).startsWith('photolocal-native-test-')) {
      throw new Error('Refusing to remove a path outside the native script fixture');
    }
    rmSync(resolvedFixture, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform !== 'win32')('native server scripts', () => {
  it('provides guarded PowerShell entry points instead of port-based taskkill', () => {
    expect(existsSync(stopScript)).toBe(true);
    expect(existsSync(startScript)).toBe(true);
    const stop = readFileSync(new URL('../../stop.bat', import.meta.url), 'utf8');
    const start = readFileSync(new URL('../../start.bat', import.meta.url), 'utf8');
    expect(stop).not.toMatch(/taskkill|netstat/i);
    expect(stop).toContain('DisableDelayedExpansion');
    expect(start).toContain('DisableDelayedExpansion');
    expect(start.indexOf('-CheckOnly')).toBeLessThan(start.indexOf('call npm'));
    expect(start).not.toContain('-Command');
  });

  it.each([
    { id: 10, name: 'com.docker.backend.exe' },
    { id: 10, name: 'docker-proxy.exe' },
    { id: 10, name: 'other.exe' },
    { id: 10, command: 'relative' as const },
    { id: 10, command: 'other' as const },
    { id: 10, command: 'missing' as const },
  ])('refuses to stop an unverified listener: %j', (process) => {
    const result = runFixture('stop', [process]);
    expect(result.failure).toBeTruthy();
    expect(result.events).not.toContain('stop:10');
  });

  it('validates every listener before stopping any process', () => {
    const result = runFixture('stop', [{ id: 10 }, { id: 20, name: 'com.docker.backend.exe' }]);
    expect(result.failure).toBeTruthy();
    expect(result.events).not.toContain('stop:10');
    expect(result.events).not.toContain('stop:20');
  });

  it('stops only verified Node listeners and deduplicates IPv4/IPv6 owners', () => {
    const result = runFixture('stop', [{ id: 10 }, { id: 10 }, { id: 20 }]);
    expect(result.failure).toBeNull();
    expect(result.events).toEqual(['inspect:10', 'inspect:20', 'stop:10', 'stop:20']);
  });

  it('succeeds without stopping anything when the port is free', () => {
    const result = runFixture('stop', []);
    expect(result.failure).toBeNull();
    expect(result.events).toEqual([]);
  });

  it('does not stop any listener when one PID changes identity during validation', () => {
    const result = runFixture('stop', [{ id: 10 }, { id: 20, hasChangedIdentity: true }]);
    expect(result.failure).toBeTruthy();
    expect(result.events).toEqual(['inspect:10', 'inspect:20']);
  });

  it('refuses native startup on an occupied port', () => {
    const result = runFixture('start', [{ id: 10, name: 'com.docker.backend.exe' }]);
    expect(result.failure).toBeTruthy();
    expect(result.events).not.toContain('start');
  });

  it('starts Node with the quoted absolute server path, preserving special path characters', () => {
    const result = runFixture('start', []);
    expect(result.failure).toBeNull();
    expect(result.started).toMatchObject({ argument: '"' + result.server + '"', windowStyle: 'Hidden' });
    expect(result.events).toEqual(['start']);
  });

  it('uses canonical fixture and process paths when Windows TEMP is an 8.3 alias', (context) => {
    const temporaryParent = realpathSync.native(tmpdir());
    const aliasRoot = realpathSync.native(mkdtempSync(join(temporaryParent, 'photolocal-native-alias-')));
    const previousTmp = process.env.TMP;
    const previousTemp = process.env.TEMP;
    try {
      const literal = "'" + aliasRoot.replaceAll("'", "''") + "'";
      const alias = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(New-Object -ComObject Scripting.FileSystemObject).GetFolder(${literal}).ShortPath`], {
        encoding: 'utf8', timeout: 15_000, windowsHide: true,
      }).trim();
      expect(realpathSync.native(alias).toLowerCase()).toBe(aliasRoot.toLowerCase());
      if (alias.toLowerCase() === aliasRoot.toLowerCase()) {
        context.skip();
        return;
      }
      process.env.TMP = alias;
      process.env.TEMP = alias;
      const stopped = runFixture('stop', [{ id: 10 }]);
      expect(stopped.failure).toBeNull();
      expect(stopped.events).toEqual(['inspect:10', 'stop:10']);
      const started = runFixture('start', []);
      expect(started.failure).toBeNull();
      expect(started.started).toMatchObject({ argument: '"' + started.server + '"', windowStyle: 'Hidden' });
      expect(started.events).toEqual(['start']);
    } finally {
      if (previousTmp === undefined) delete process.env.TMP;
      else process.env.TMP = previousTmp;
      if (previousTemp === undefined) delete process.env.TEMP;
      else process.env.TEMP = previousTemp;
      if (dirname(aliasRoot) !== temporaryParent || !basename(aliasRoot).startsWith('photolocal-native-alias-')) {
        throw new Error('Refusing to remove a path outside the native alias fixture');
      }
      rmSync(aliasRoot, { recursive: true, force: true });
    }
  });
});
