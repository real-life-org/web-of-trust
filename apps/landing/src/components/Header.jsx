import { Menu, X, ChevronDown } from 'lucide-react'
import { useState, useRef, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Button } from '@real-life-stack/toolkit'
import GitHubIcon from './icons/GitHubIcon'
import { useLanguage, SUPPORTED_LANGUAGES } from '../i18n/LanguageContext'
import { useAudience, AUDIENCES } from '../audience'

export default function Header() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [langDropdownOpen, setLangDropdownOpen] = useState(false)
  const [audienceDropdownOpen, setAudienceDropdownOpen] = useState(false)
  const langDropdownRef = useRef(null)
  const audienceDropdownRef = useRef(null)
  const { language, setLanguage, t } = useLanguage()
  const { audience, setAudience, currentAudience, isEnabled: audienceEnabled } = useAudience()

  const currentLang = SUPPORTED_LANGUAGES.find(l => l.code === language)

  const location = useLocation()
  const isLandingPage = location.pathname === '/'

  const navItems = [
    { label: t.nav.concept, href: isLandingPage ? '#konzept' : '/#konzept', isRoute: !isLandingPage },
    { label: t.nav.apps, href: isLandingPage ? '#apps' : '/#apps', isRoute: !isLandingPage },
    { label: t.architecture?.nav || 'Architecture', href: '/architecture', isRoute: true },
    { label: t.nav.blog, href: '/blog', isRoute: true },
  ]

  // Close dropdowns when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (langDropdownRef.current && !langDropdownRef.current.contains(event.target)) {
        setLangDropdownOpen(false)
      }
      if (audienceDropdownRef.current && !audienceDropdownRef.current.contains(event.target)) {
        setAudienceDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleLanguageSelect = (code) => {
    setLanguage(code)
    setLangDropdownOpen(false)
  }

  const handleAudienceSelect = (code) => {
    setAudience(code)
    setAudienceDropdownOpen(false)
  }

  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-background/80 backdrop-blur-md border-b border-border">
      <nav className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary rounded-xl flex items-center justify-center">
              <svg viewBox="0 1 23 22" className="w-6 h-6 text-primary-foreground" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="18.72" cy="8.82" r="2.5" />
                <circle cx="5.28" cy="5.28" r="2.5" />
                <circle cx="8.82" cy="18.72" r="2.5" />
                <line x1="6.04" x2="8.06" y1="8.18" y2="15.82" />
                <line x1="15.81" x2="8.18" y1="8.05" y2="6.04" />
                <line x1="16.59" x2="10.94" y1="10.94" y2="16.59" />
              </svg>
            </div>
            <span className="font-bold text-lg text-foreground">Web of Trust</span>
          </Link>

          {/* Desktop Navigation */}
          <div className="hidden md:flex items-center gap-8">
            {navItems.map((item) => (
              item.isRoute ? (
                <Link
                  key={item.href}
                  to={item.href}
                  className="text-sm font-medium text-muted-foreground hover:text-primary transition-colors"
                >
                  {item.label}
                </Link>
              ) : (
                <a
                  key={item.href}
                  href={item.href}
                  className="text-sm font-medium text-muted-foreground hover:text-primary transition-colors"
                >
                  {item.label}
                </a>
              )
            ))}

            {/* Audience Dropdown - only shown when ?personas or ?audience param is present */}
            {audienceEnabled && (
              <div className="relative" ref={audienceDropdownRef}>
                <button
                  onClick={() => setAudienceDropdownOpen(!audienceDropdownOpen)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-primary transition-colors rounded-md hover:bg-muted"
                  title={currentAudience?.description}
                >
                  <span>{currentAudience?.icon}</span>
                  <span className="hidden lg:inline">{currentAudience?.label}</span>
                  <ChevronDown size={14} className={`transition-transform ${audienceDropdownOpen ? 'rotate-180' : ''}`} />
                </button>

                {audienceDropdownOpen && (
                  <div className="absolute right-0 mt-2 w-56 bg-background border border-border rounded-lg shadow-lg py-1 z-50">
                    <div className="px-3 py-2 text-xs text-muted-foreground uppercase tracking-wider border-b border-border">
                      Perspektive
                    </div>
                    {AUDIENCES.map((aud) => (
                      <button
                        key={aud.code}
                        onClick={() => handleAudienceSelect(aud.code)}
                        className={`w-full px-4 py-2.5 text-left text-sm flex items-center gap-3 hover:bg-muted transition-colors ${
                          audience === aud.code ? 'text-primary font-medium bg-muted/50' : 'text-muted-foreground'
                        }`}
                      >
                        <span className="text-lg">{aud.icon}</span>
                        <div>
                          <div>{aud.label}</div>
                          <div className="text-xs text-muted-foreground/70">{aud.description}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Language Dropdown */}
            <div className="relative" ref={langDropdownRef}>
              <button
                onClick={() => setLangDropdownOpen(!langDropdownOpen)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-primary transition-colors rounded-md hover:bg-muted"
              >
                <span>{currentLang?.flag} {currentLang?.code.toUpperCase()}</span>
                <ChevronDown size={14} className={`transition-transform ${langDropdownOpen ? 'rotate-180' : ''}`} />
              </button>

              {langDropdownOpen && (
                <div className="absolute right-0 mt-2 w-40 bg-background border border-border rounded-lg shadow-lg py-1 z-50">
                  {SUPPORTED_LANGUAGES.map((lang) => (
                    <button
                      key={lang.code}
                      onClick={() => handleLanguageSelect(lang.code)}
                      className={`w-full px-4 py-2 text-left text-sm flex items-center gap-2 hover:bg-muted transition-colors ${
                        language === lang.code ? 'text-primary font-medium' : 'text-muted-foreground'
                      }`}
                    >
                      <span>{lang.flag}</span>
                      <span>{lang.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <Button asChild variant="outline" size="default">
              <a
                href="https://github.com/antontranelis/web-of-trust-concept"
                target="_blank"
                rel="noopener noreferrer"
              >
                <GitHubIcon />
                GitHub
              </a>
            </Button>
          </div>

          {/* Mobile Menu Button */}
          <button
            className="md:hidden p-2 text-muted-foreground"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          >
            {mobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>

        {/* Mobile Navigation */}
        {mobileMenuOpen && (
          <div className="md:hidden py-4 border-t border-border">
            <div className="flex flex-col gap-4">
              {navItems.map((item) => (
                item.isRoute ? (
                  <Link
                    key={item.href}
                    to={item.href}
                    className="text-base font-medium text-muted-foreground hover:text-primary transition-colors"
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    {item.label}
                  </Link>
                ) : (
                  <a
                    key={item.href}
                    href={item.href}
                    className="text-base font-medium text-muted-foreground hover:text-primary transition-colors"
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    {item.label}
                  </a>
                )
              ))}

              {/* Mobile Audience Select - only shown when ?personas or ?audience param is present */}
              {audienceEnabled && (
                <div className="border-t border-border pt-4">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2 px-1">
                    Perspektive
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {AUDIENCES.map((aud) => (
                      <button
                        key={aud.code}
                        onClick={() => {
                          setAudience(aud.code)
                        }}
                        className={`px-3 py-2 text-sm rounded-md flex items-center gap-2 transition-colors ${
                          audience === aud.code
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted text-muted-foreground hover:bg-muted/80'
                        }`}
                      >
                        <span>{aud.icon}</span>
                        <span>{aud.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Mobile Language Select */}
              <div className="border-t border-border pt-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2 px-1">
                  {language === 'de' ? 'Sprache' : 'Language'}
                </p>
                <div className="flex flex-wrap gap-2">
                  {SUPPORTED_LANGUAGES.map((lang) => (
                    <button
                      key={lang.code}
                      onClick={() => {
                        setLanguage(lang.code)
                        setMobileMenuOpen(false)
                      }}
                      className={`px-3 py-2 text-sm rounded-md flex items-center gap-2 transition-colors ${
                        language === lang.code
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground hover:bg-muted/80'
                      }`}
                    >
                      <span>{lang.flag}</span>
                      <span>{lang.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <Button asChild variant="outline" className="w-full">
                <a
                  href="https://github.com/antontranelis/web-of-trust-concept"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <GitHubIcon />
                  GitHub
                </a>
              </Button>
            </div>
          </div>
        )}
      </nav>
    </header>
  )
}
