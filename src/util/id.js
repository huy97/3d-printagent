import { randomBytes } from 'node:crypto';

export function shortId(prefix = '') {
  const raw = randomBytes(6).toString('hex');
  return prefix ? `${prefix}_${raw}` : raw;
}

export function apiKeyValue() {
  return `p3d_${randomBytes(24).toString('base64url')}`;
}
