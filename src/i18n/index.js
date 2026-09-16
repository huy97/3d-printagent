import { vi } from './vi.js';
import { en } from './en.js';

export const LOCALES = ['vi', 'en'];
export const DEFAULT_LOCALE = 'vi';

const CATALOGS = { vi, en };

// Không đọc LANG của hệ điều hành: máy dev thường để en_US trong khi người dùng vẫn muốn tiếng Việt.
// Thứ tự quyết định: biến môi trường PRINTAGENT3D_LANG > agent.locale trong cấu hình > DEFAULT_LOCALE.
let currentLocale = process.env.PRINTAGENT3D_LANG ? normalizeLocale(process.env.PRINTAGENT3D_LANG) : DEFAULT_LOCALE;

export function normalizeLocale(value) {
  const tag = String(value ?? '').trim().toLowerCase().split(/[._-]/)[0];
  return LOCALES.includes(tag) ? tag : DEFAULT_LOCALE;
}

export function getLocale() {
  return currentLocale;
}

export function setLocale(value) {
  currentLocale = normalizeLocale(value);
  return currentLocale;
}

/** Đọc Accept-Language theo thứ tự q giảm dần, lấy ngôn ngữ đầu tiên agent hỗ trợ. */
export function localeFromAcceptLanguage(header) {
  if (!header) return null;
  const ranked = String(header)
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.find((item) => item.trim().startsWith('q='));
      return { tag: tag.trim().toLowerCase(), q: q ? Number(q.split('=')[1]) || 0 : 1 };
    })
    .sort((a, b) => b.q - a.q);
  const match = ranked.find((item) => LOCALES.includes(item.tag.split('-')[0]));
  return match ? match.tag.split('-')[0] : null;
}

export function localeFromRequest(req) {
  const explicit = req?.headers?.['x-locale'] ?? req?.query?.lang ?? req?.query?.locale;
  const tag = String(explicit ?? '').trim().toLowerCase().split(/[._-]/)[0];
  if (LOCALES.includes(tag)) return tag;
  return localeFromAcceptLanguage(req?.headers?.['accept-language']) ?? currentLocale;
}

function interpolate(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    params[name] === undefined ? match : String(params[name]),
  );
}

export function t(key, params, locale) {
  const tag = locale ? normalizeLocale(locale) : currentLocale;
  const text = CATALOGS[tag]?.[key] ?? CATALOGS[DEFAULT_LOCALE][key];
  if (text === undefined) return key;
  return interpolate(text, params);
}
