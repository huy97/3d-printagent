import { AppError, badRequest } from '../../util/errors.js';

const MAX_RANGE_MINUTES = 3650 * 24 * 60;

function timeParam(value, field) {
  if (value === undefined || value === '') return undefined;
  const number = /^\d+$/.test(String(value)) ? Number(value) : Date.parse(String(value));
  if (!Number.isFinite(number)) throw badRequest('error.field_invalid', { field });
  return number;
}

/** `from`/`to` nhận epoch ms hoặc ISO 8601; không có `from` thì lấy `minutes` gần nhất (mặc định 30). */
export function historyRange(query = {}) {
  const to = timeParam(query.to, 'to');
  let from = timeParam(query.from, 'from');
  if (from === undefined) {
    const minutes = Math.min(MAX_RANGE_MINUTES, Math.max(1, Number(query.minutes) || 30));
    from = (to ?? Date.now()) - minutes * 60000;
  }
  return { from, to, maxPoints: query.points ? Number(query.points) : undefined };
}

export const wrap = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

export function requestOrigin(req) {
  if (req.headers['x-client'] === 'web-ui') return 'ui';
  return req.auth?.key?.name ? `api:${req.auth.key.name}` : 'api';
}

export function requireLocal(req) {
  if (!req.auth?.local) throw new AppError('error.local_only', { status: 403, code: 'local_only' });
}
