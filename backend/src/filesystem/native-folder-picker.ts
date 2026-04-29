import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface NativeFolderPickResult {
  path: string | null;
}

interface ExecFileError extends Error {
  code?: number | string;
}

function quotePowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export async function pickWindowsFolder(initialPath?: string): Promise<NativeFolderPickResult> {
  if (process.platform !== 'win32') {
    throw new Error('Native folder picker is available only on Windows');
  }

  const safeInitialPath = quotePowerShellString(initialPath?.trim() ?? '');
  const script = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Wybierz folder zadania'
$dialog.ShowNewFolderButton = $true
$initialPath = ${safeInitialPath}
if ($initialPath -and (Test-Path -LiteralPath $initialPath -PathType Container)) {
  $dialog.SelectedPath = $initialPath
}
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
  exit 0
}
exit 2
`;

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        encoding: 'utf8',
        timeout: 10 * 60 * 1000,
        windowsHide: false,
      },
    );

    return { path: stdout.trim() || null };
  } catch (error) {
    const execError = error as ExecFileError;
    if (execError.code === 2) {
      return { path: null };
    }

    throw error;
  }
}
