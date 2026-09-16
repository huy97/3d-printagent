import { en } from './en'
import { vi } from './vi'

export type Locale = 'vi' | 'en'
export type MessageKey = keyof typeof vi

export const LOCALES: Locale[] = ['vi', 'en']
export const LOCALE_LABELS: Record<Locale, string> = { vi: 'Tiếng Việt', en: 'English' }
export const LOCALE_SHORT: Record<Locale, string> = { vi: 'VI', en: 'EN' }

const CATALOGS: Record<Locale, Record<string, string>> = { vi, en }
const STORAGE_KEY = 'printagent3d.locale'
const DEFAULT_LOCALE: Locale = 'en'

function readStored(): Locale {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === 'vi' || value === 'en') return value
  } catch {
    // localStorage is blocked when the browser disallows third-party cookies
  }
  return DEFAULT_LOCALE
}

let current: Locale = readStored()

export function getLocale(): Locale {
  return current
}

export function storeLocale(locale: Locale) {
  current = locale
  try {
    localStorage.setItem(STORAGE_KEY, locale)
  } catch {
    // Cannot persist, still use it for the current session
  }
}

export function translate(locale: Locale, key: MessageKey, params?: Record<string, string | number>) {
  const template = CATALOGS[locale]?.[key] ?? CATALOGS[DEFAULT_LOCALE][key] ?? key
  return interpolate(template, params)
}

export function translateOptional(locale: Locale, key: string, params?: Record<string, string | number>) {
  const template = CATALOGS[locale]?.[key] ?? CATALOGS[DEFAULT_LOCALE][key]
  return template ? interpolate(template, params) : null
}

function interpolate(template: string, params?: Record<string, string | number>) {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    params[name] === undefined ? match : String(params[name]),
  )
}
