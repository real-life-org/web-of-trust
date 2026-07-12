import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { Capacitor } from '@capacitor/core'
import { de } from './de'
import { en } from './en'
import { interpolate } from './utils'
import type { Translations, SupportedLanguage, LanguageConfig } from './types'

const SUPPORTED_LANGUAGES: LanguageConfig[] = [
  { code: 'de', label: 'Deutsch' },
  { code: 'en', label: 'English' },
]

const translationMap: Record<SupportedLanguage, Translations> = { de, en }
const validLangs = SUPPORTED_LANGUAGES.map(l => l.code)

function isValidLang(lang: string): lang is SupportedLanguage {
  return validLangs.includes(lang as SupportedLanguage)
}

interface LanguageContextValue {
  language: SupportedLanguage
  t: Translations
  fmt: (template: string, values: Record<string, string | number>) => string
  formatDate: (date: string | Date) => string
}

const LanguageContext = createContext<LanguageContextValue | null>(null)

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language] = useState<SupportedLanguage>(() => {
    // 1. URL parameter
    const urlParams = new URLSearchParams(window.location.search)
    const urlLang = urlParams.get('lang')
    if (urlLang && isValidLang(urlLang)) return urlLang

    // 2. localStorage — only on non-native platforms.
    // On native (Android/iOS) the OS per-app language is the switch: it drives
    // navigator.language, so a stale localStorage value must not overshadow it.
    if (!Capacitor.isNativePlatform()) {
      const stored = localStorage.getItem('wot-language')
      if (stored && isValidLang(stored)) return stored
    }

    // 3. Browser language (= system per-app locale on native)
    const browserLang = navigator.language.split('-')[0]
    if (isValidLang(browserLang)) return browserLang

    // 4. Default to English
    return 'en'
  })

  useEffect(() => {
    // Persist only on non-native platforms; on native the OS per-app language is
    // the source of truth, so we must not write a value that would later pin it.
    if (!Capacitor.isNativePlatform()) {
      localStorage.setItem('wot-language', language)
    }
    document.documentElement.lang = language
  }, [language])

  const t = translationMap[language]

  const fmt = useCallback((template: string, values: Record<string, string | number>) => {
    return interpolate(template, values)
  }, [])

  const formatDate = useCallback((date: string | Date) => {
    const d = typeof date === 'string' ? new Date(date) : date
    return d.toLocaleDateString(language === 'de' ? 'de-DE' : 'en-US')
  }, [language])

  return (
    <LanguageContext.Provider value={{ language, t, fmt, formatDate }}>
      {children}
    </LanguageContext.Provider>
  )
}

export function useLanguage() {
  const context = useContext(LanguageContext)
  if (!context) throw new Error('useLanguage must be used within a LanguageProvider')
  return context
}
