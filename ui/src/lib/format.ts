import { getLocale, translate } from '@/i18n/locale'
import type { Temperature } from './api'

const INTL_LOCALE: Record<string, string> = { vi: 'vi-VN', en: 'en-US' }

function intlLocale() {
  return INTL_LOCALE[getLocale()] ?? 'vi-VN'
}

export function formatTime(value?: string | number | null) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString(intlLocale())
}

export function formatClock(value?: string | number | null) {
  if (!value) return ''
  return new Date(value).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function formatBytes(value?: number | null) {
  if (!value && value !== 0) return '-'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function formatNumber(value?: number | null, digits = 0) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-'
  return value.toLocaleString(intlLocale(), { maximumFractionDigits: digits })
}

export function formatMoney(value?: number | null, currency = 'VND') {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-'
  try {
    return value.toLocaleString(intlLocale(), { style: 'currency', currency, maximumFractionDigits: currency === 'VND' ? 0 : 2 })
  } catch {
    return `${formatNumber(value, 2)} ${currency}`
  }
}

export function formatGrams(value?: number | null) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-'
  return Math.abs(value) >= 1000 ? `${formatNumber(value / 1000, 2)} kg` : `${formatNumber(value, 1)} g`
}

/** Localized duration such as "1h 05m", short enough to sit next to a progress bar. */
export function formatDuration(seconds?: number | null) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '-'
  const locale = getLocale()
  const total = Math.max(0, Math.round(seconds))
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (days > 0) return translate(locale, 'duration.days_hours', { days, hours })
  if (hours > 0) return translate(locale, 'duration.hours_minutes', { hours, minutes: String(minutes).padStart(2, '0') })
  if (minutes > 0) return translate(locale, 'duration.minutes', { minutes })
  return translate(locale, 'duration.seconds', { seconds: total })
}

export function formatUptime(seconds?: number) {
  return formatDuration(seconds ?? 0)
}

export function formatHourMinute(value: number) {
  return new Date(value).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' })
}

export function formatDayTime(value: number) {
  return new Date(value).toLocaleString(intlLocale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function formatEta(remaining?: number | null) {
  if (!remaining) return null
  return formatHourMinute(Date.now() + remaining * 1000)
}

export function formatTemp(value?: Temperature | null) {
  if (!value) return '-'
  const actual = Math.round(value.actual)
  return value.target ? `${actual}° / ${Math.round(value.target)}°` : `${actual}°`
}

export type Tone = 'ok' | 'warn' | 'err' | 'info' | 'brand' | 'muted'

export function statusTone(status: string): Tone {
  switch (status) {
    case 'completed':
    case 'idle':
    case 'running':
    case 'finished':
      return 'ok'
    case 'printing':
      return 'brand'
    case 'uploading':
    case 'starting':
    case 'busy':
    case 'connecting':
    case 'stopping':
    case 'registered':
      return 'info'
    case 'queued':
    case 'paused':
    case 'cancelled':
    case 'canceled':
      return 'warn'
    case 'failed':
    case 'error':
    case 'offline':
      return 'err'
    default:
      return 'muted'
  }
}
