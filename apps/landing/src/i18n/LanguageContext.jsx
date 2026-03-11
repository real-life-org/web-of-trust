import { createContext, useContext, useState, useEffect } from 'react'
import { translations } from './translations'

export const SUPPORTED_LANGUAGES = [
  { code: 'de', label: 'Deutsch', flag: '🇩🇪' },
  { code: 'en', label: 'English', flag: '🇬🇧' },
  { code: 'fr', label: 'Français', flag: '🇫🇷' },
  { code: 'es', label: 'Español', flag: '🇪🇸' },
  { code: 'pt', label: 'Português', flag: '🇧🇷' },
  { code: 'it', label: 'Italiano', flag: '🇮🇹' },
  { code: 'tr', label: 'Türkçe', flag: '🇹🇷' },
  { code: 'ar', label: 'العربية', flag: '🇸🇦', rtl: true },
  { code: 'zh', label: '中文', flag: '🇨🇳' },
  { code: 'ru', label: 'Русский', flag: '🇷🇺' },
  { code: 'uk', label: 'Українська', flag: '🇺🇦' },
  { code: 'he', label: 'עברית', flag: '🇮🇱', rtl: true },
]

const LanguageContext = createContext()

export function LanguageProvider({ children }) {
  const [language, setLanguage] = useState(() => {
    // Check URL parameter first
    const urlParams = new URLSearchParams(window.location.search)
    const urlLang = urlParams.get('lang')
    const validLangs = SUPPORTED_LANGUAGES.map(l => l.code)
    if (urlLang && validLangs.includes(urlLang)) {
      return urlLang
    }

    // Check localStorage
    const stored = localStorage.getItem('wot-language')
    if (stored && validLangs.includes(stored)) {
      return stored
    }

    // Check browser language
    const browserLang = navigator.language.split('-')[0]
    if (validLangs.includes(browserLang)) {
      return browserLang
    }

    // Default to English
    return 'en'
  })

  useEffect(() => {
    localStorage.setItem('wot-language', language)
    document.documentElement.lang = language
  }, [language])

  const t = translations[language]

  const toggleLanguage = () => {
    setLanguage(prev => prev === 'de' ? 'en' : 'de')
  }

  return (
    <LanguageContext.Provider value={{ language, setLanguage, toggleLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  )
}

export function useLanguage() {
  const context = useContext(LanguageContext)
  if (!context) {
    throw new Error('useLanguage must be used within a LanguageProvider')
  }
  return context
}
