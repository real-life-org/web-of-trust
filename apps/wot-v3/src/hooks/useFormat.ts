// Dates and times in the app language and the clock's time zone (architecture §6.4).
import { useMemo } from 'react'
import { formatDay, formatTime, localDay, previousDay, useI18n } from '../i18n'
import { usePlatform } from './context'

export interface Format {
  time(at: number): string
  /** "Today", "Yesterday" or a date, for a DayDivider.day */
  dayLabel(day: string): string
}

export function useFormat(): Format {
  const { lang, t } = useI18n()
  const { clock } = usePlatform()
  return useMemo(() => {
    const tz = clock.timeZone()
    const today = localDay(clock.now(), tz)
    const yesterday = previousDay(today)
    return {
      time: (at) => formatTime(at, lang, tz),
      dayLabel: (day) => (day === today ? t.days.today : day === yesterday ? t.days.yesterday : formatDay(day, lang)),
    }
  }, [lang, t, clock])
}
