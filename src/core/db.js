import { DatabaseSync } from 'node:sqlite';
import { PATHS, ensureDataDirs } from './paths.js';

const MIGRATIONS = [
  `CREATE TABLE jobs (
     id TEXT PRIMARY KEY,
     printer_id TEXT NOT NULL,
     status TEXT NOT NULL,
     created_at TEXT NOT NULL,
     data TEXT NOT NULL
   );
   CREATE INDEX jobs_created ON jobs (created_at);
   CREATE TABLE telemetry (
     printer_id TEXT NOT NULL,
     t INTEGER NOT NULL,
     nozzle REAL,
     nozzle_target REAL,
     bed REAL,
     bed_target REAL,
     chamber REAL,
     fan INTEGER,
     speed INTEGER,
     progress REAL,
     layer INTEGER,
     state TEXT
   );
   CREATE INDEX telemetry_printer_time ON telemetry (printer_id, t);`,
  `CREATE TABLE slice_messages (
     id TEXT PRIMARY KEY,
     file_id TEXT NOT NULL,
     created_at TEXT NOT NULL,
     data TEXT NOT NULL
   );
   CREATE INDEX slice_messages_file ON slice_messages (file_id);
   CREATE TABLE slice_versions (
     id TEXT PRIMARY KEY,
     file_id TEXT NOT NULL,
     created_at TEXT NOT NULL,
     data TEXT NOT NULL
   );
   CREATE INDEX slice_versions_file ON slice_versions (file_id);`,
  `CREATE TABLE slice_presets (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     created_at TEXT NOT NULL,
     data TEXT NOT NULL
   );
   CREATE UNIQUE INDEX slice_presets_name ON slice_presets (name COLLATE NOCASE);`,
  `CREATE TABLE spools (
     id TEXT PRIMARY KEY,
     created_at TEXT NOT NULL,
     data TEXT NOT NULL
   );
   CREATE TABLE material_cache (
     file_id TEXT NOT NULL,
     plate INTEGER NOT NULL,
     data TEXT NOT NULL,
     PRIMARY KEY (file_id, plate)
   );
   CREATE TABLE print_records (
     job_id TEXT PRIMARY KEY,
     printer_id TEXT NOT NULL,
     file_id TEXT,
     status TEXT NOT NULL,
     finished_at TEXT NOT NULL,
     duration REAL,
     data TEXT NOT NULL
   );
   CREATE INDEX print_records_printer ON print_records (printer_id, finished_at);
   CREATE INDEX print_records_finished ON print_records (finished_at);
   CREATE TABLE maintenance_tasks (
     id TEXT PRIMARY KEY,
     printer_id TEXT NOT NULL,
     data TEXT NOT NULL
   );
   CREATE INDEX maintenance_tasks_printer ON maintenance_tasks (printer_id);
   CREATE TABLE maintenance_seeded (printer_id TEXT PRIMARY KEY);`,
];

let db = null;
const statements = new Map();

export function openDb() {
  if (db) return db;
  ensureDataDirs();
  db = new DatabaseSync(PATHS.db);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let index = version; index < MIGRATIONS.length; index += 1) {
    transaction(() => {
      db.exec(MIGRATIONS[index]);
      db.exec(`PRAGMA user_version = ${index + 1}`);
    });
  }
  return db;
}

export function closeDb() {
  if (!db) return;
  statements.clear();
  db.close();
  db = null;
}

/** Prepared statements reused per SQL text. */
export function sql(text) {
  const database = openDb();
  let statement = statements.get(text);
  if (!statement) {
    statement = database.prepare(text);
    statements.set(text, statement);
  }
  return statement;
}

export function transaction(action) {
  const database = db ?? openDb();
  database.exec('BEGIN');
  try {
    const result = action();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
