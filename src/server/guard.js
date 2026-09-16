import { createLogger } from '../util/logger.js';
import { t } from '../i18n/index.js';

const log = createLogger('guard');

const WINDOW_MS = 60000;
const MAX_FAILURES = 10;
const BLOCK_MS = 300000;

const attempts = new Map();

function clientKey(req) {
  const forwarded = req.headers?.['cf-connecting-ip'] ?? req.headers?.['x-real-ip'] ?? req.headers?.['x-forwarded-for'];
  const first = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : null;
  return first || req.socket?.remoteAddress || req.ip || 'unknown';
}

function prune(now) {
  for (const [key, entry] of attempts) {
    if (entry.blockedUntil && entry.blockedUntil > now) continue;
    if (now - entry.updatedAt > BLOCK_MS) attempts.delete(key);
  }
}

/** Trả về số mili giây còn bị chặn, 0 nếu được phép thử tiếp. */
export function blockedFor(req) {
  const entry = attempts.get(clientKey(req));
  if (!entry?.blockedUntil) return 0;
  const remain = entry.blockedUntil - Date.now();
  return remain > 0 ? remain : 0;
}

export function recordAuthFailure(req) {
  const now = Date.now();
  prune(now);
  const key = clientKey(req);
  const entry = attempts.get(key) ?? { count: 0, updatedAt: now, blockedUntil: 0 };
  if (now - entry.updatedAt > WINDOW_MS) entry.count = 0;
  entry.count += 1;
  entry.updatedAt = now;
  if (entry.count >= MAX_FAILURES) {
    entry.blockedUntil = now + BLOCK_MS;
    entry.count = 0;
    log.warn(t('guard.blocked', { client: key, minutes: Math.round(BLOCK_MS / 60000) }));
  }
  attempts.set(key, entry);
}

export function recordAuthSuccess(req) {
  attempts.delete(clientKey(req));
}
