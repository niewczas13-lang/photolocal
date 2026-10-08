import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('update-native.bat', () => {
  it.skipIf(process.platform !== 'win32')(
    'finishes building and restarting when git pull replaces the running batch file',
    () => {
      const productionScript = readFileSync(new URL('../../update-native.bat', import.meta.url), 'utf8');
      const pipCommand = 'python -m pip install -r "%~dp0pobierzchat\\requirements.txt"';
      expect(productionScript).toContain(pipCommand);
      const fixtureScript = productionScript.replace(
        pipCommand,
        'echo Skipping Python installation in fixture',
      );
      const temporaryParent = realpathSync(tmpdir());
      const fixturePrefix = 'photolocal-update-bat-';
      const fixturePath = mkdtempSync(join(temporaryParent, fixturePrefix));

      try {
        const sourcePath = join(fixturePath, 'source');
        const remotePath = join(fixturePath, 'remote.git');
        const clientPath = join(fixturePath, 'client');
        const hooksPath = join(fixturePath, 'disabled-hooks');
        const globalConfigPath = join(fixturePath, 'empty.gitconfig');
        mkdirSync(hooksPath);
        writeFileSync(globalConfigPath, '');
        const fixtureEnv = {
          ...process.env,
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'core.hooksPath',
          GIT_CONFIG_VALUE_0: hooksPath,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: globalConfigPath,
          GIT_TERMINAL_PROMPT: '0',
        };
        const git = (args: string[], cwd: string): string =>
          execFileSync(
            'git',
            [
              '-c',
              'user.name=Update regression fixture',
              '-c',
              'user.email=test@example.invalid',
              ...args,
            ],
            { cwd, env: fixtureEnv, encoding: 'utf8', timeout: 15_000 },
          );
        const batch = (lines: string[]): string => lines.join('\r\n') + '\r\n';

        git(['init', '--initial-branch=main', sourcePath], fixturePath);
        writeFileSync(join(sourcePath, 'update.bat'), fixtureScript);
        writeFileSync(
          join(sourcePath, 'stop.bat'),
          batch(['@echo off', '>>"%~dp0update-markers.txt" echo stop', 'exit /b 0']),
        );
        writeFileSync(
          join(sourcePath, 'start.bat'),
          batch(['@echo off', '>>"%~dp0update-markers.txt" echo start', 'exit /b 0']),
        );
        writeFileSync(
          join(sourcePath, 'npm.cmd'),
          batch([
            '@echo off',
            'if "%~1"=="install" >>"%~dp0update-markers.txt" echo install',
            'if "%~1 %~2"=="run build" >>"%~dp0update-markers.txt" echo build',
            'exit /b 0',
          ]),
        );
        git(['add', '--', 'update.bat', 'stop.bat', 'start.bat', 'npm.cmd'], sourcePath);
        git(['commit', '-m', 'Fixture updater v1'], sourcePath);
        git(['init', '--bare', '--initial-branch=main', remotePath], fixturePath);
        git(['push', remotePath, 'main'], sourcePath);
        git(['clone', remotePath, clientPath], fixturePath);

        const longerHeader = 'rem Updated updater header '.padEnd(188, 'x') + '\r\n';
        writeFileSync(join(sourcePath, 'update.bat'), longerHeader + fixtureScript);
        git(['add', '--', 'update.bat'], sourcePath);
        git(['commit', '-m', 'Fixture updater v2 with longer header'], sourcePath);
        git(['push', remotePath, 'main'], sourcePath);

        let exitCode = 0;
        let output = '';
        try {
          output = execFileSync('cmd.exe', ['/d', '/s', '/c', 'update.bat'], {
            cwd: clientPath,
            env: fixtureEnv,
            encoding: 'utf8',
            input: '\r\n',
            timeout: 15_000,
          });
        } catch (error: unknown) {
          if (
            !(error instanceof Error) ||
            !('status' in error) ||
            typeof error.status !== 'number'
          ) {
            throw error;
          }
          exitCode = error.status;
          if ('stdout' in error && typeof error.stdout === 'string') output = error.stdout;
        }
        const markersPath = join(clientPath, 'update-markers.txt');
        const markers = existsSync(markersPath)
          ? readFileSync(markersPath, 'utf8').trim().split(/\r?\n/)
          : [];
        expect(readFileSync(join(clientPath, 'update.bat'), 'utf8')).toBe(
          longerHeader + fixtureScript,
        );
        expect({ exitCode, output, markers }).toMatchObject({
          exitCode: 0,
          markers: expect.arrayContaining(['build', 'start']),
        });
      } finally {
        const resolvedFixture = realpathSync(fixturePath);
        if (
          dirname(resolvedFixture) !== temporaryParent ||
          !basename(resolvedFixture).startsWith(fixturePrefix)
        ) {
          throw new Error('Refusing to remove a path outside the updater test fixture');
        }
        rmSync(resolvedFixture, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
