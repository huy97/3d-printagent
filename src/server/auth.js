import { timingSafeEqual } from 'node:crypto';
import { getConfig, saveConfig } from '../core/config.js';
import { unauthorized, AppError } from '../util/errors.js';
import { blockedFor, recordAuthFailure, recordAuthSuccess } from './guard.js';

const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);

const PROXY_HEADERS = [
  'x-forwarded-for',
  'x-real-ip',
  'cf-connecting-ip',
  'cf-ray',
  'ngrok-agent-ips',
  'x-original-forwarded-for',
];

const LAST_USED_THROTTLE_MS = 60000;

/**
 * Request qua cloudflared/ngrok cũng đến từ 127.0.0.1, còn request do một trang web
 * bất kỳ khởi tạo thì mang header Origin lạ. Cả hai trường hợp đều không được
 * hưởng ngoại lệ "miễn API key cho localhost".
 *
 * Ba điều kiện dưới đây độc lập nhau, cố ý không dựa vào mỗi việc thiếu header proxy:
 * kẻ tấn công đi qua tunnel phải phá được cả ba mới chạm tới ngoại lệ này.
 */
export function isLocalRequest(req) {
  const address = req.socket?.remoteAddress ?? req.ip ?? '';
  if (!LOCAL_ADDRESSES.has(address)) return false;
  if (!isLoopbackHost(req)) return false;
  if (PROXY_HEADERS.some((header) => req.headers?.[header])) return false;
  if (!isSameSiteFetch(req)) return false;
  return isSameOrigin(req);
}

/**
 * Trình duyệt tự gắn Sec-Fetch-Site và trang web không sửa được, kể cả với thẻ
 * <img>/<script> vốn không gửi Origin. Chỉ chấp nhận điều hướng trực tiếp (none)
 * hoặc request từ chính trang của agent (same-origin).
 */
export function isSameSiteFetch(req) {
  const site = req.headers?.['sec-fetch-site'];
  if (!site) return true;
  return site === 'same-origin' || site === 'none';
}

/** Qua tunnel thì Host là tên miền công khai, chỉ trình duyệt trên chính máy mới gửi Host loopback. */
export function isLoopbackHost(req) {
  const host = req.headers?.host;
  if (!host) return true;
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
  return LOCAL_ADDRESSES.has(hostname);
}

export function isSameOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    if (!LOCAL_ADDRESSES.has(originUrl.hostname)) return false;
    const host = req.headers?.host;
    return !host || originUrl.host === host;
  } catch {
    return false;
  }
}

/**
 * Trang do chính agent phục vụ (kể cả khi mở qua tunnel) có Origin trùng Host.
 * Dùng cho WebSocket: không nới lỏng ngoại lệ miễn key của isLocalRequest.
 */
export function isSelfServedOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers?.host;
  } catch {
    return false;
  }
}

export function extractKey(req) {
  const header = req.headers?.['x-api-key'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const auth = req.headers?.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const queryKey = req.query?.apiKey ?? req.query?.api_key;
  if (typeof queryKey === 'string' && queryKey.trim()) return queryKey.trim();
  return null;
}

function keysMatch(candidate, stored) {
  const a = Buffer.from(candidate);
  const b = Buffer.from(stored);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function verifyKey(key) {
  if (!key) return null;
  const config = getConfig();
  const entry = config.auth.apiKeys.find((item) => keysMatch(key, item.key));
  if (!entry) return null;
  const last = entry.lastUsedAt ? Date.parse(entry.lastUsedAt) : 0;
  if (Date.now() - last > LAST_USED_THROTTLE_MS) {
    entry.lastUsedAt = new Date().toISOString();
    saveConfig(config, { silent: true });
  }
  return entry;
}

export function authorize(req) {
  const config = getConfig();
  const local = isLocalRequest(req);
  if (!config.auth.enabled) return { ok: true, key: null, local, reason: 'auth_disabled' };
  const key = extractKey(req);
  const entry = verifyKey(key);
  if (entry) return { ok: true, key: entry, local, reason: 'api_key' };
  if (config.auth.allowLocalhostWithoutKey && local) {
    return { ok: true, key: null, local, reason: 'localhost' };
  }
  return { ok: false, local };
}

export function requireAuth(req, res, next) {
  const blocked = blockedFor(req);
  if (blocked > 0) {
    res.setHeader('retry-after', String(Math.ceil(blocked / 1000)));
    next(new AppError('error.too_many_attempts', {
      status: 429,
      code: 'too_many_attempts',
      params: { seconds: Math.ceil(blocked / 1000) },
    }));
    return;
  }
  const result = authorize(req);
  if (!result.ok) {
    recordAuthFailure(req);
    next(unauthorized());
    return;
  }
  if (!result.local) recordAuthSuccess(req);
  req.auth = result;
  next();
}
