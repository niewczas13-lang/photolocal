import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { auditProjectPhotoFiles, writePhotoFileAuditCsv, type PhotoFileAuditIssue } from './photo-file-audit.js';

interface CliOptions {
  projectIds: string[];
  reportPath: string | null;
  limit: number;
}

function printHelp(): void {
  console.log('Audyt zdjec Photo Local');
  console.log('');
  console.log('Uzycie: npm run audit:photo-files --workspace backend -- [opcje]');
  console.log('');
  console.log('Opcje:');
  console.log('  --project-id ID       Sprawdz tylko jeden projekt. Mozna podac kilka razy.');
  console.log('  --report PATH         Zapisz CSV pod wskazana sciezka.');
  console.log('  --no-report           Nie zapisuj CSV, tylko wypisz podsumowanie.');
  console.log('  --limit N             Ile problemow pokazac w konsoli. Domyslnie 30.');
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    projectIds: [],
    reportPath: null,
    limit: 30,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }

    if (arg === '--no-report') {
      options.reportPath = '';
      continue;
    }

    if (arg === '--project-id') {
      const value = argv[index + 1];
      if (!value) throw new Error('Brakuje wartosci po --project-id');
      options.projectIds.push(value);
      index += 1;
      continue;
    }

    if (arg.startsWith('--project-id=')) {
      options.projectIds.push(arg.slice('--project-id='.length));
      continue;
    }

    if (arg === '--report') {
      const value = argv[index + 1];
      if (!value) throw new Error('Brakuje wartosci po --report');
      options.reportPath = resolve(value);
      index += 1;
      continue;
    }

    if (arg.startsWith('--report=')) {
      options.reportPath = resolve(arg.slice('--report='.length));
      continue;
    }

    if (arg === '--limit') {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value < 0) throw new Error('Niepoprawna wartosc --limit');
      options.limit = Math.floor(value);
      index += 1;
      continue;
    }

    if (arg.startsWith('--limit=')) {
      const value = Number(arg.slice('--limit='.length));
      if (!Number.isFinite(value) || value < 0) throw new Error('Niepoprawna wartosc --limit');
      options.limit = Math.floor(value);
      continue;
    }

    throw new Error(`Nieznana opcja: ${arg}`);
  }

  return options;
}

function defaultReportPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return resolve(process.cwd(), '..', 'logs', `audyt-zdjec-${stamp}.csv`);
}

function printIssue(issue: PhotoFileAuditIssue): void {
  const target = issue.targetPath ? ` | ${issue.targetPath}` : '';
  const file = issue.storedFileName ? ` | ${issue.storedFileName}` : '';
  console.log(`[${issue.code}] ${issue.projectName}${target}${file}`);
  console.log(`  ${issue.message}`);
  if (issue.storagePath) console.log(`  plik: ${issue.storagePath}`);
  if (issue.thumbnailPath) console.log(`  miniatura: ${issue.thumbnailPath}`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const db = new Database(config.dbPath, { readonly: true, fileMustExist: true });
  const reportPath = options.reportPath === '' ? null : options.reportPath ?? defaultReportPath();

  try {
    console.log('Audyt zdjec Photo Local');
    console.log(`Baza: ${config.dbPath}`);
    if (options.projectIds.length > 0) console.log(`Projekty: ${options.projectIds.join(', ')}`);
    console.log('');

    const result = auditProjectPhotoFiles(db, {
      projectIds: options.projectIds,
      onProgress: (event) => {
        if (event.phase === 'start') {
          console.log(`Sprawdzam projekty: ${event.totalProjects}`);
          return;
        }
        if (event.phase === 'project') {
          console.log(`[${event.processedProjects}/${event.totalProjects}] ${event.projectName}`);
          return;
        }
        console.log('Sprawdzanie zakonczone.');
      },
    });

    if (reportPath) {
      mkdirSync(dirname(reportPath), { recursive: true });
      writePhotoFileAuditCsv(reportPath, result.issues);
    }

    console.log('');
    console.log('Podsumowanie audytu:');
    console.log(`  Projekty: ${result.projectCount}`);
    console.log(`  Zdjecia checklisty w bazie: ${result.checklistPhotoRows}`);
    console.log(`  Zdjecia notatek w bazie: ${result.notePhotoRows}`);
    console.log(`  Brakujace foldery projektow: ${result.missingProjectFolders}`);
    console.log(`  Brakujace duze pliki: ${result.missingStorageFiles}`);
    console.log(`  Przypadki: duzy plik brak, miniatura jest: ${result.thumbnailFallbackOnly}`);
    console.log(`  Brakujace miniatury: ${result.missingThumbnailFiles}`);
    console.log(`  Rozjazdy rozmiaru pliku: ${result.sizeMismatches}`);
    console.log(`  Sciezki poza folderem projektu: ${result.outsideProjectPaths}`);
    console.log(`  Bledy dostepu do plikow: ${result.accessErrors}`);
    console.log(`  Problemy razem: ${result.issues.length}`);
    if (reportPath) console.log(`  Raport CSV: ${reportPath}`);

    const visibleIssues = result.issues.slice(0, options.limit);
    if (visibleIssues.length > 0) {
      console.log('');
      console.log(`Pierwsze problemy (${visibleIssues.length}/${result.issues.length}):`);
      for (const issue of visibleIssues) printIssue(issue);
      if (result.issues.length > visibleIssues.length) {
        console.log(`... i jeszcze ${result.issues.length - visibleIssues.length} problemow w raporcie CSV.`);
      }
    }
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
