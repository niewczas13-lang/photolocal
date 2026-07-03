import Database from 'better-sqlite3';
import { ensureDefaultUsers, listAppUsers } from './app-auth.js';
import { loadConfig } from '../config.js';
import { runMigrations } from '../db/migrations.js';

function pad(value: string, width: number): string {
  return value.padEnd(width, ' ');
}

const config = loadConfig();
const db = new Database(config.dbPath);

try {
  runMigrations(db);
  ensureDefaultUsers(db);
  const users = listAppUsers(db);
  const rows = users.map((user) => ({
    login: user.username,
    haslo: user.displayedPassword ?? '(ustawione inne - nie do odczytu)',
    typ: user.defaultPasswordWorks ? 'domyslne' : user.hashType,
    utworzono: user.createdAt,
  }));

  const widths = {
    login: Math.max('Login'.length, ...rows.map((row) => row.login.length)),
    haslo: Math.max('Haslo'.length, ...rows.map((row) => row.haslo.length)),
    typ: Math.max('Typ'.length, ...rows.map((row) => row.typ.length)),
    utworzono: Math.max('Utworzono'.length, ...rows.map((row) => row.utworzono.length)),
  };

  console.log(`Baza: ${config.dbPath}`);
  console.log('');
  console.log(
    `${pad('Login', widths.login)}  ${pad('Haslo', widths.haslo)}  ${pad('Typ', widths.typ)}  ${pad('Utworzono', widths.utworzono)}`,
  );
  console.log(
    `${'-'.repeat(widths.login)}  ${'-'.repeat(widths.haslo)}  ${'-'.repeat(widths.typ)}  ${'-'.repeat(widths.utworzono)}`,
  );

  for (const row of rows) {
    console.log(
      `${pad(row.login, widths.login)}  ${pad(row.haslo, widths.haslo)}  ${pad(row.typ, widths.typ)}  ${pad(row.utworzono, widths.utworzono)}`,
    );
  }

  console.log('');
  console.log('Uwaga: prawdziwych zmienionych hasel nie da sie wyswietlic, bo w bazie sa tylko hashe.');
  console.log('Zmiana albo reset hasla: dodaj-konto.bat');
} finally {
  db.close();
}
