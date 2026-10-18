import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import { de } from './de'
import { en } from './en'
import type { SupportedLanguage, Translations } from './types'
import { interpolate } from './utils'

const DICTIONARIES: Record<SupportedLanguage, Translations> = { en, de }

export interface I18n {
  readonly lang: SupportedLanguage
  readonly t: Translations
  /** interpolate a template from `t` */
  readonly f: (template: string, values?: Readonly<Record<string, string | number>>) => string
}

const I18nContext = createContext<I18n | null>(null)

export function LanguageProvider({ lang, children }: { lang: SupportedLanguage; children: ReactNode }) {
  const value = useMemo<I18n>(() => ({ lang, t: DICTIONARIES[lang], f: interpolate }), [lang])
  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n outside LanguageProvider')
  return ctx
}
