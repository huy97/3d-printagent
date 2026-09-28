import { t } from '../i18n/index.js';

export class AppError extends Error {
  /**
   * `key` is the message id in the i18n catalog, clients use it to translate on their own;
   * `message` is already translated into the agent's current language, for logs and CLI.
   */
  constructor(key, { status = 400, code = 'bad_request', params, details } = {}) {
    super(t(key, params));
    this.name = 'AppError';
    this.key = key;
    this.params = params;
    this.status = status;
    this.code = code;
    this.details = details;
  }

  localize(locale) {
    return t(this.key, this.params, locale);
  }
}

export const badRequest = (key, params, details) =>
  new AppError(key, { status: 400, code: 'bad_request', params, details });
export const unauthorized = (key = 'error.unauthorized', params) =>
  new AppError(key, { status: 401, code: 'unauthorized', params });
export const forbidden = (key, params) => new AppError(key, { status: 403, code: 'forbidden', params });
export const notFound = (key = 'error.not_found', params) =>
  new AppError(key, { status: 404, code: 'not_found', params });
export const conflict = (key, params, details) =>
  new AppError(key, { status: 409, code: 'conflict', params, details });
export const unsupported = (key = 'error.unsupported', params) =>
  new AppError(key, { status: 501, code: 'unsupported', params });
export const upstreamError = (key, params, details) =>
  new AppError(key, { status: 502, code: 'printer_error', params, details });

/** Wraps any thrown value into an AppError so every error payload carries an i18n key. */
export function toAppError(error) {
  if (error instanceof AppError) return error;
  const message = error?.stderr?.trim() || error?.message || String(error ?? '');
  if (error?.type === 'entity.parse.failed') {
    return new AppError('error.invalid_json_body', { status: 400, code: 'bad_request' });
  }
  if (error?.type === 'entity.too.large') {
    return new AppError('error.payload_too_large', { status: 413, code: 'payload_too_large' });
  }
  const raw = Number(error?.status ?? error?.statusCode);
  const status = raw >= 400 && raw < 600 ? raw : 500;
  if (status < 500) {
    return new AppError('error.request_failed', { status, code: 'bad_request', params: { message } });
  }
  return new AppError('error.internal', { status, code: 'internal_error', params: { message }, details: error?.details });
}

/** Wire format shared by REST, WebSocket and MCP error payloads. */
export function serializeError(error, locale) {
  const appError = toAppError(error);
  return {
    code: appError.code,
    key: appError.key,
    params: appError.params ?? undefined,
    message: appError.localize(locale),
    details: appError.details,
  };
}

/** Stored form of a failure on a record (job, printer status): translated text plus its key. */
export function failureFields(error, prefix = 'error') {
  if (!error) return { [prefix]: null, [`${prefix}Key`]: null, [`${prefix}Params`]: null };
  const appError = toAppError(error);
  return { [prefix]: appError.message, [`${prefix}Key`]: appError.key, [`${prefix}Params`]: appError.params ?? null };
}
