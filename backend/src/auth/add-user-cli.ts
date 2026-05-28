import Database from 'better-sqlite3';
import { upsertAppUser } from './app-auth.js';
import { loadConfig } from '../config.js';
import { runMigrations } from '../db/migrations.js';

const [username, password] = process.argv.slice(2);

if (!username || !password) {
  console.error('Uzycie: npm run auth:add-user -- <login> <haslo>');
  process.exit(1);
}

const config = loadConfig();
const db = new Database(config.dbPath);

try {
  runMigrations(db);
  const user = upsertAppUser(db, username, password);
  console.log(`OK: konto ${user.username} zapisane w ${config.dbPath}`);
} finally {
  db.close();
}
