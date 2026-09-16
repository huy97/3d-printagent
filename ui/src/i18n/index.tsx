import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { getLocale, storeLocale, translate, type Locale, type MessageKey } from './locale'

export { LOCALES, LOCALE_LABELS, LOCALE_SHORT, getLocale } from './locale'
export type { Locale, MessageKey } from './locale'

export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string

type I18nValue = {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: Translate
}

const I18nContext = createContext<I18nValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(getLocale)

  const setLocale = useCallback((next: Locale) => {
    storeLocale(next)
    setLocaleState(next)
    document.documentElement.lang = next
  }, [])

  const value = useMemo<I18nValue>(
    () => ({ locale, setLocale, t: (key, params) => translate(locale, key, params) }),
    [locale, setLocale],
  )

  return <I18nContext value={value}>{children}</I18nContext>
}

export function useI18n() {
  const value = useContext(I18nContext)
  if (!value) throw new Error('useI18n must be used within I18nProvider')
  return value
}

export function useT(): Translate {
  return useI18n().t
}
