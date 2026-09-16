import { vi } from './vi.js';
import { en } from './en.js';

export const LOCALES = ['vi', 'en'];
export const DEFAULT_LOCALE = 'en';

const CATALOGS = { vi, en };

// Ignore the OS LANG: dev machines are often en_US while the user still wants Vietnamese.
// Precedence: PRINTAGENT3D_LANG env var > agent.locale in config > DEFAULT_LOCALE.
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

/** Reads Accept-Language by descending q, picking the first locale the agent supports. */
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
