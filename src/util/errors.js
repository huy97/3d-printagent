import { t } from '../i18n/index.js';

export class AppError extends Error {
  /**
   * `key` là mã thông báo trong catalog i18n, client dùng nó để tự dịch;
   * `message` là bản đã dịch theo ngôn ngữ hiện hành của agent, dùng cho log và CLI.
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
