import { FileText, Heart } from 'lucide-react'
import { Button } from '@real-life-stack/toolkit'
import GitHubIcon from './icons/GitHubIcon'
import { useLanguage } from '../i18n/LanguageContext'

export default function Footer() {
  const { t } = useLanguage()

  const links = {
    projekt: [
      { label: t.footer.links.project.concept, href: 'https://github.com/antontranelis/web-of-trust-concept' },
      { label: t.footer.links.project.prototype, href: '/demo/' },
      { label: t.footer.links.project.specification, href: 'https://github.com/antontranelis/web-of-trust-concept' },
    ],
    mitmachen: [
      { label: t.footer.links.contribute.issues, href: 'https://github.com/antontranelis/web-of-trust-concept/issues' },
      { label: t.footer.links.contribute.feedback, href: 'https://github.com/antontranelis/web-of-trust-concept/discussions' },
      { label: t.footer.links.contribute.code, href: 'https://github.com/antontranelis/web-of-trust-concept/pulls' },
    ],
  }

  return (
    <footer className="bg-foreground dark:bg-card text-background dark:text-foreground">
      {/* CTA Section */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="text-center max-w-2xl mx-auto">
          <h2 className="text-3xl font-bold mb-4">
            {t.footer.cta.title}
          </h2>
          <p className="text-background/60 dark:text-muted-foreground mb-8">
            {t.footer.cta.subtitle}
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Button asChild variant="outline" size="lg" className="border-background bg-background text-foreground hover:bg-background/90 dark:border-border dark:bg-muted dark:hover:bg-muted/80">
              <a
                href="https://github.com/antontranelis/web-of-trust-concept"
                target="_blank"
                rel="noopener noreferrer"
              >
                <GitHubIcon />
                {t.footer.cta.github}
              </a>
            </Button>
            <Button asChild variant="outline" size="lg" className="border-background/30 bg-transparent text-background hover:bg-background/10 dark:border-border dark:text-foreground dark:hover:bg-muted/50">
              <a
                href="https://github.com/antontranelis/web-of-trust-concept"
                target="_blank"
                rel="noopener noreferrer"
              >
                <FileText />
                {t.footer.cta.spec}
              </a>
            </Button>
          </div>
        </div>
      </div>

      {/* Links Section */}
      <div className="border-t border-background/20 dark:border-border">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          <div className="grid md:grid-cols-4 gap-8">
            {/* Logo & Description */}
            <div className="md:col-span-2">
              <div className="flex items-center gap-3 mb-4">
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
                <span className="font-bold text-lg">Web of Trust</span>
              </div>
              <p className="text-background/60 dark:text-muted-foreground text-sm max-w-md">
                {t.footer.description}
              </p>
            </div>

            {/* Project Links */}
            <div>
              <h3 className="font-semibold text-background dark:text-foreground mb-4">{t.footer.projectTitle}</h3>
              <ul className="space-y-2">
                {links.projekt.map((link, index) => {
                  const isExternal = link.href.startsWith('http')
                  return (
                    <li key={index}>
                      <a
                        href={link.href}
                        {...(isExternal ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                        className="text-background/60 dark:text-muted-foreground hover:text-background dark:hover:text-foreground transition-colors text-sm"
                      >
                        {link.label}
                      </a>
                    </li>
                  )
                })}
              </ul>
            </div>

            {/* Mitmachen Links */}
            <div>
              <h3 className="font-semibold text-background dark:text-foreground mb-4">{t.footer.contributeTitle}</h3>
              <ul className="space-y-2">
                {links.mitmachen.map((link, index) => (
                  <li key={index}>
                    <a
                      href={link.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-background/60 dark:text-muted-foreground hover:text-background dark:hover:text-foreground transition-colors text-sm"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Bar */}
      <div className="border-t border-background/20 dark:border-border">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <p className="text-background/50 dark:text-muted-foreground text-sm">
              {t.footer.license}
            </p>
            <p className="text-background/50 dark:text-muted-foreground text-sm flex items-center gap-1">
              {t.footer.madeWith.prefix} <Heart size={14} className="text-destructive" /> {t.footer.madeWith.suffix}
            </p>
          </div>
        </div>
      </div>
    </footer>
  )
}
