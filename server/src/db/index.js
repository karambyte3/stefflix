import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrations } from './migrations.js';

/** Opens (and migrates) a database. Pass ':memory:' in tests. */
export function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  for (let version = current; version < migrations.length; version++) {
    db.transaction(() => {
      db.exec(migrations[version]);
      db.pragma(`user_version = ${version + 1}`);
    })();
    console.log(`Database migrated to version ${version + 1}`);
  }
}

let instance = null;

/** The app-wide database. Call initDb() once at startup. */
export function getDb() {
  if (!instance) throw new Error('Database is not initialised - call initDb() first');
  return instance;
}

export function initDb(file) {
  instance = openDatabase(file);
  return instance;
}

/** JSON helpers for TEXT columns. */
export function parseJson(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
