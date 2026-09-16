import os from 'node:os';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

export const DATA_DIR = process.env.PRINTAGENT3D_DATA_DIR || path.join(os.homedir(), '.3d-printagent');

export const PATHS = {
  data: DATA_DIR,
  config: path.join(DATA_DIR, 'config.json'),
  printers: path.join(DATA_DIR, 'printers.json'),
  db: path.join(DATA_DIR, 'data.db'),
  library: path.join(DATA_DIR, 'library'),
  libraryIndex: path.join(DATA_DIR, 'library', 'index.json'),
  tmp: path.join(DATA_DIR, 'tmp'),
  logs: path.join(DATA_DIR, 'logs'),
};

export function ensureDataDirs() {
  for (const dir of [PATHS.data, PATHS.library, PATHS.tmp, PATHS.logs]) {
    mkdirSync(dir, { recursive: true });
  }
  return PATHS;
}
