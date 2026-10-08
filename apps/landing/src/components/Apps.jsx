import { Map, Calendar, Store, Heart } from 'lucide-react'
import { Card } from '@real-life/toolkit'
import { useLanguage } from '../i18n/LanguageContext'

const colorClasses = {
  primary: {
    bg: 'bg-primary/10',
    text: 'text-primary',
    border: 'border-primary/20',
  },
  secondary: {
    bg: 'bg-secondary/10',
    text: 'text-secondary',
    border: 'border-secondary/20',
  },
  accent: {
    bg: 'bg-warning/10',
    text: 'text-warning',
    border: 'border-warning/20',
  },
  pink: {
    bg: 'bg-pink/10',
    text: 'text-pink',
    border: 'border-pink/20',
  },
}

export default function Apps() {
  const { t } = useLanguage()

  const apps = [
    {
      icon: Map,
      title: t.apps.items[0].title,
      description: t.apps.items[0].description,
      color: 'primary',
    },
    {
      icon: Calendar,
      title: t.apps.items[1].title,
      description: t.apps.items[1].description,
      color: 'secondary',
    },
    {
      icon: Store,
      title: t.apps.items[2].title,
      description: t.apps.items[2].description,
      color: 'accent',
    },
    {
      icon: Heart,
      title: t.apps.items[3].title,
      description: t.apps.items[3].description,
      color: 'pink',
    },
  ]

  return (
    <section id="apps" className="py-16 md:py-24 bg-background">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-foreground mb-4">
            {t.apps.title}
          </h2>
          <p className="text-lg text-muted-foreground leading-relaxed max-w-2xl mx-auto">
            {t.apps.subtitle}
          </p>
        </div>

        {/* App Cards */}
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 mb-16">
          {apps.map((app, index) => {
            const colors = colorClasses[app.color]
            const Icon = app.icon

            return (
              <Card key={index} className={`px-6 gap-0 ${colors.border} text-center`}>
                <div className={`w-14 h-14 ${colors.bg} rounded-xl flex items-center justify-center mx-auto mb-4`}>
                  <Icon className={colors.text} size={28} />
                </div>
                <h3 className="text-lg font-semibold text-foreground mb-2">
                  {app.title}
                </h3>
                <p className="text-muted-foreground text-sm">
                  {app.description}
                </p>
              </Card>
            )
          })}
        </div>

        {/* Subtle note */}
        <div className="text-center">
          <p className="text-sm text-muted-foreground">
            {t.apps.note.prefix}{' '}
            <a
              href="https://real-life-stack.de"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Real Life Stack
            </a>
            {' '}{t.apps.note.suffix}
          </p>
        </div>
      </div>
    </section>
  )
}
