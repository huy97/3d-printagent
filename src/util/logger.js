import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export const logEvents = new EventEmitter();
logEvents.setMaxListeners(0);

let minLevel = LEVELS[process.env.PRINTAGENT3D_LOG_LEVEL] ?? LEVELS.info;
let logFile = null;
let silentStdout = false;
const ring = [];
const RING_SIZE = 500;

export function configureLogger({ dir, level, silent } = {}) {
  if (level && LEVELS[level]) minLevel = LEVELS[level];
  if (typeof silent === 'boolean') silentStdout = silent;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, `agent-${new Date().toISOString().slice(0, 10)}.log`);
  }
}

function write(level, scope, message, meta) {
  if (LEVELS[level] < minLevel) return;
  const entry = {
    time: new Date().toISOString(),
    level,
    scope,
    message,
    ...(meta ? { meta } : {}),
  };
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();
  logEvents.emit('log', entry);

  const line = `${entry.time} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${
    meta ? ` ${safeJson(meta)}` : ''
  }`;
  if (!silentStdout) {
    if (level === 'error') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }
  if (logFile) {
    try {
      appendFileSync(logFile, `${line}\n`);
    } catch {
      // không chặn luồng chính vì lỗi ghi log
    }
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

export function recentLogs(limit = 200) {
  return ring.slice(-limit);
}

export function createLogger(scope) {
  return {
    debug: (msg, meta) => write('debug', scope, msg, meta),
    info: (msg, meta) => write('info', scope, msg, meta),
    warn: (msg, meta) => write('warn', scope, msg, meta),
    error: (msg, meta) => write('error', scope, msg, meta),
  };
}
