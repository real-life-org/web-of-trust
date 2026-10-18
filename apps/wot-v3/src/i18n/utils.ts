import type { SupportedLanguage } from './types'

export function interpolate(template: string, values: Readonly<Record<string, string | number>> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = values[key]
    return value !== undefined ? String(value) : `{${key}}`
  })
}

/** Local day YYYY-MM-DD of an instant (same shape as DayDivider.day). */
export function localDay(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

/** 24-hour clock time, as in the design ("09:20"). */
export function formatTime(at: number, lang: SupportedLanguage, timeZone: string): string {
  return new Intl.DateTimeFormat(lang === 'de' ? 'de-DE' : 'en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at)
}

/** "Oct 14, 2026" / "14. Okt. 2026" for days that are neither today nor yesterday. */
export function formatDay(day: string, lang: SupportedLanguage): string {
  const [y, m, d] = day.split('-').map(Number)
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12))
  return new Intl.DateTimeFormat(lang === 'de' ? 'de-DE' : 'en-US', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

/** The day before a YYYY-MM-DD day. */
export function previousDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) - 1, 12))
  return date.toISOString().slice(0, 10)
}
