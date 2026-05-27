import { loadConfig } from '../config.js';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrations.js';
import { hashProjectPhotoFolders, type PhotoHashProgressEvent } from './photo-hash-cache.js';

function printProgress(event: PhotoHashProgressEvent): void {
  if (event.phase === 'counting') {
    console.log('[0%] Licze zdjecia w folderach aktualnych projektow...');
    return;
  }

  if (event.phase === 'done') {
    console.log('[100%] Zakonczono haszowanie zdjec.');
    return;
  }

  const projectName = event.projectName ? ` | ${event.projectName}` : '';
  const currentPath = event.currentPath ? ` | ${event.currentPath}` : '';
  console.log(`[${event.percent}%] ${event.processed}/${event.total}${projectName}${currentPath}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);

  try {
    runMigrations(db);
    console.log(`Baza: ${config.dbPath}`);
    const result = await hashProjectPhotoFolders(db, { onProgress: printProgress });

    console.log('');
    console.log('Podsumowanie haszowania:');
    console.log(`  Projekty: ${result.projectCount}`);
    console.log(`  Zdjecia znalezione: ${result.filesFound}`);
    console.log(`  Zhaszowane: ${result.hashedFiles}`);
    console.log(`  Bez zmian z cache: ${result.skippedUnchanged}`);
    console.log(`  Uzupelnione wpisy photos.content_hash: ${result.updatedPhotoRows}`);
    console.log(`  Grupy duplikatow na dysku: ${result.duplicateGroups}`);
    console.log(`  Pliki w grupach duplikatow: ${result.duplicateFiles}`);
    console.log(`  Bledy: ${result.errorCount}`);

    for (const error of result.errors.slice(0, 20)) {
      console.log(`  [BLAD] ${error.path}: ${error.message}`);
    }
    if (result.errors.length > 20) {
      console.log(`  ... i jeszcze ${result.errors.length - 20} bledow.`);
    }
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
