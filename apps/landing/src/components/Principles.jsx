import { Lock, Users, WifiOff, Github, Ban, Database, Key, RefreshCw } from 'lucide-react'
import { Card } from '@real-life-stack/toolkit'
import { useLanguage } from '../i18n/LanguageContext'

const colorClasses = {
  primary: {
    bg: 'bg-primary/10',
    text: 'text-primary',
  },
  secondary: {
    bg: 'bg-secondary/10',
    text: 'text-secondary',
  },
  accent: {
    bg: 'bg-warning/10',
    text: 'text-warning',
  },
  slate: {
    bg: 'bg-muted',
    text: 'text-muted-foreground',
  },
}

export default function Principles() {
  const { t } = useLanguage()

  const principles = [
    {
      icon: Lock,
      title: t.principles.items[0].title,
      description: t.principles.items[0].description,
      color: 'primary',
    },
    {
      icon: Users,
      title: t.principles.items[1].title,
      description: t.principles.items[1].description,
      color: 'secondary',
    },
    {
      icon: WifiOff,
      title: t.principles.items[2].title,
      description: t.principles.items[2].description,
      color: 'accent',
    },
    {
      icon: Github,
      title: t.principles.items[3].title,
      description: t.principles.items[3].description,
      color: 'slate',
    },
    {
      icon: Key,
      title: t.principles.items[4].title,
      description: t.principles.items[4].description,
      color: 'primary',
    },
    {
      icon: Database,
      title: t.principles.items[5].title,
      description: t.principles.items[5].description,
      color: 'secondary',
    },
  ]

  const notFeatures = [
    { icon: Ban, text: t.principles.notFeatures[0] },
    { icon: Ban, text: t.principles.notFeatures[1] },
    { icon: Ban, text: t.principles.notFeatures[2] },
    { icon: Ban, text: t.principles.notFeatures[3] },
  ]

  return (
    <section className="py-16 md:py-24 bg-muted">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-foreground mb-4">
            {t.principles.title}
          </h2>
          <p className="text-lg text-muted-foreground leading-relaxed max-w-2xl mx-auto">
            {t.principles.subtitle}
          </p>
        </div>

        {/* Principles Grid */}
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 mb-16">
          {principles.map((principle, index) => {
            const colors = colorClasses[principle.color]
            const Icon = principle.icon

            return (
              <Card key={index} className="px-6 gap-0">
                <div className={`w-12 h-12 ${colors.bg} rounded-xl flex items-center justify-center mb-4`}>
                  <Icon className={colors.text} size={24} />
                </div>
                <h3 className="text-lg font-semibold text-foreground mb-2">
                  {principle.title}
                </h3>
                <p className="text-muted-foreground text-sm">
                  {principle.description}
                </p>
              </Card>
            )
          })}
        </div>

        {/* What It's Not */}
        <div className="max-w-3xl mx-auto">
          <div className="bg-foreground dark:bg-card rounded-2xl p-8 text-background dark:text-foreground">
            <h3 className="text-xl font-bold mb-6 text-center">
              {t.principles.notTitle.prefix} <span className="text-destructive">{t.principles.notTitle.highlight}</span> {t.principles.notTitle.suffix}
            </h3>
            <div className="grid sm:grid-cols-2 gap-4">
              {notFeatures.map((item, index) => {
                const Icon = item.icon
                return (
                  <div key={index} className="flex items-center gap-3">
                    <Icon className="text-destructive flex-shrink-0" size={20} />
                    <span className="text-background/70 dark:text-muted-foreground">{item.text}</span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* Bottom Note */}
        <div className="mt-12 text-center">
          <div className="inline-flex items-center gap-2 text-muted-foreground">
            <RefreshCw size={16} />
            <span className="text-sm">
              {t.principles.note}
            </span>
          </div>
        </div>


      </div>
    </section>
  )
}
