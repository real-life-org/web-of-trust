import { ArrowDown, Users, Shield, Heart, Handshake } from 'lucide-react'
import { Button } from '@real-life-stack/toolkit'
import { Link } from 'react-router-dom'
import { useLanguage } from '../i18n/LanguageContext'
import { useAudience } from '../audience'

export default function Hero() {
  const { t } = useLanguage()
  const { getContent, audience, isEnabled } = useAudience()

  // Only use audience content when enabled via URL param
  const showAudienceContent = isEnabled && audience !== 'default'
  const audienceHero = showAudienceContent ? getContent('hero') : null
  const audiencePhilosophy = showAudienceContent ? getContent('philosophy') : null

  return (
    <section className="relative min-h-screen bg-gradient-to-br from-primary/8 via-background to-secondary/8 flex items-center pt-16 overflow-hidden">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="max-w-4xl mx-auto text-center">
          {/* Badge - Audience-aware */}
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-primary/10 text-primary rounded-full text-sm font-medium mb-8">
            <span>{audienceHero?.tagline || t.hero.badge}</span>
          </div>

          {/* Main Headline - Audience-aware */}
          <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight text-foreground mb-6">
            {showAudienceContent ? (
              <span className="text-primary">{audienceHero?.title}</span>
            ) : (
              <>
                {t.hero.titleStart}{' '}
                <span className="text-primary">{t.hero.titleHighlight}</span>
              </>
            )}
          </h1>

          {/* Subheadline - Audience-aware */}
          <p className="text-lg text-muted-foreground leading-relaxed max-w-2xl mx-auto mb-6">
            {audienceHero?.subtitle || t.hero.subtitle}
          </p>

          {/* Philosophy Quote - Only shown when audience mode is enabled */}
          {showAudienceContent && audiencePhilosophy && (
            <div className="relative max-w-xl mx-auto mb-10 p-6 bg-gradient-to-r from-primary/5 via-secondary/5 to-primary/5 rounded-2xl border border-primary/10">
              <blockquote className="text-lg italic text-foreground/80 mb-2">
                "{audiencePhilosophy.quote}"
              </blockquote>
              <p className="text-sm text-muted-foreground">
                — {audiencePhilosophy.headline}
              </p>
            </div>
          )}

          {/* CTA Buttons */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16">
            <Button asChild size="lg">
              <a href="/demo/">
                {t.hero.demo}
              </a>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/architecture">
                {t.hero.architecture || 'Architektur'}
              </Link>
            </Button>
          </div>

          {/* Key Points — link to architecture */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-16">
            <Link to="/architecture" className="flex items-center justify-center gap-3 text-muted-foreground hover:text-primary transition-colors">
              <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                <Users size={20} className="text-primary" />
              </div>
              <span className="font-medium">{t.hero.features.verification}</span>
            </Link>
            <Link to="/architecture" className="flex items-center justify-center gap-3 text-muted-foreground hover:text-secondary transition-colors">
              <div className="w-10 h-10 rounded-full bg-secondary/10 flex items-center justify-center">
                <Shield size={20} className="text-secondary" />
              </div>
              <span className="font-medium">{t.hero.features.encrypted}</span>
            </Link>
            <Link to="/architecture" className="flex items-center justify-center gap-3 text-muted-foreground hover:text-warning transition-colors">
              <div className="w-10 h-10 rounded-full bg-warning/10 flex items-center justify-center">
                <svg className="w-5 h-5 text-warning" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M6.428 1.151C6.708.591 7.213 0 8 0s1.292.592 1.572 1.151C9.861 1.73 10 2.431 10 3v3.691l5.17 2.585a1.5 1.5 0 0 1 .83 1.342V12a.5.5 0 0 1-.582.493l-5.507-.918-.375 2.253 1.318 1.318A.5.5 0 0 1 10.5 16h-5a.5.5 0 0 1-.354-.854l1.319-1.318-.376-2.253-5.507.918A.5.5 0 0 1 0 12v-1.382a1.5 1.5 0 0 1 .83-1.342L6 6.691V3c0-.568.14-1.271.428-1.849m.894.448C7.111 2.02 7 2.569 7 3v4a.5.5 0 0 1-.276.447l-5.448 2.724a.5.5 0 0 0-.276.447v.792l5.418-.903a.5.5 0 0 1 .575.41l.5 3a.5.5 0 0 1-.14.437L6.708 15h2.586l-.647-.646a.5.5 0 0 1-.14-.436l.5-3a.5.5 0 0 1 .576-.411L15 11.41v-.792a.5.5 0 0 0-.276-.447L9.276 7.447A.5.5 0 0 1 9 7V3c0-.432-.11-.979-.322-1.401C8.458 1.159 8.213 1 8 1s-.458.158-.678.599" />
                </svg>
              </div>
              <span className="font-medium">{t.hero.features.offline}</span>
            </Link>
          </div>
        </div>

        {/* Scroll Indicator */}
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 animate-bounce">
          <a href="#konzept" className="text-muted-foreground/70 hover:text-primary transition-colors">
            <ArrowDown size={24} />
          </a>
        </div>
      </div>
    </section>
  )
}
