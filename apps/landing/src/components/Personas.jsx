import { Flower2, Wrench, Code2, Users } from 'lucide-react'
import { Card } from '@real-life/toolkit'
import { useLanguage } from '../i18n/LanguageContext'

const colorClasses = {
  green: {
    bg: 'bg-secondary/10',
    text: 'text-secondary',
    border: 'border-secondary/20',
    badge: 'bg-secondary/5 text-secondary',
    dot: 'bg-secondary',
  },
  orange: {
    bg: 'bg-warning/10',
    text: 'text-warning',
    border: 'border-warning/20',
    badge: 'bg-warning/10 text-warning',
    dot: 'bg-warning',
  },
  blue: {
    bg: 'bg-primary/10',
    text: 'text-primary',
    border: 'border-primary/20',
    badge: 'bg-primary/5 text-primary',
    dot: 'bg-primary',
  },
  purple: {
    bg: 'bg-pink/10',
    text: 'text-pink',
    border: 'border-pink/20',
    badge: 'bg-pink/10 text-pink',
    dot: 'bg-pink',
  },
}

export default function Personas() {
  const { t } = useLanguage()

  const personas = [
    {
      icon: Flower2,
      image: '/farmer.svg',
      name: t.personas.items[0].name,
      role: t.personas.items[0].role,
      background: t.personas.items[0].background,
      needs: t.personas.items[0].needs,
      howItHelps: t.personas.items[0].howItHelps,
      color: 'green',
    },
    {
      icon: Wrench,
      image: '/maker.svg',
      name: t.personas.items[1].name,
      role: t.personas.items[1].role,
      background: t.personas.items[1].background,
      needs: t.personas.items[1].needs,
      howItHelps: t.personas.items[1].howItHelps,
      color: 'orange',
    },
    {
      icon: Code2,
      image: '/lena.svg',
      name: t.personas.items[2].name,
      role: t.personas.items[2].role,
      background: t.personas.items[2].background,
      needs: t.personas.items[2].needs,
      howItHelps: t.personas.items[2].howItHelps,
      color: 'blue',
    },
    {
      icon: Users,
      image: '/family.svg',
      name: t.personas.items[3].name,
      role: t.personas.items[3].role,
      background: t.personas.items[3].background,
      needs: t.personas.items[3].needs,
      howItHelps: t.personas.items[3].howItHelps,
      color: 'purple',
    },
  ]

  return (
    <section id="personas" className="py-16 md:py-24 bg-background">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-foreground mb-4">
            {t.personas.title}
          </h2>
          <p className="text-lg text-muted-foreground leading-relaxed max-w-2xl mx-auto">
            {t.personas.subtitle}
          </p>
        </div>

        {/* Persona Cards */}
        <div className="grid md:grid-cols-2 gap-8">
          {personas.map((persona, index) => {
            const colors = colorClasses[persona.color]

            return (
              <Card key={index} className={`px-6 gap-0 ${colors.border}`}>
                {/* Header */}
                <div className="flex items-start gap-4 mb-6">
                  <div className={`w-16 h-16 ${colors.bg} rounded-2xl flex items-center justify-center overflow-hidden`}>
                    {persona.image ? (
                      <img src={persona.image} alt={persona.name} className="w-12 h-12 object-contain" />
                    ) : (
                      <span className="text-5xl">{persona.emoji}</span>
                    )}
                  </div>
                  <div>
                    <h3 className="text-xl font-bold text-foreground">
                      {persona.name}
                    </h3>
                    <span className={`inline-block px-3 py-1 rounded-full text-sm font-medium ${colors.badge} mt-1`}>
                      {persona.role}
                    </span>
                  </div>
                </div>

                {/* Background */}
                <p className="text-muted-foreground mb-4">
                  {persona.background}
                </p>

                {/* Needs */}
                <div className="mb-4">
                  <h4 className="text-sm font-semibold text-muted-foreground/70 uppercase tracking-wider mb-2">
                    {t.personas.needsLabel}
                  </h4>
                  <ul className="space-y-1">
                    {persona.needs.map((need, needIndex) => (
                      <li key={needIndex} className="flex items-center gap-2 text-muted-foreground">
                        <span className={`w-1.5 h-1.5 rounded-full ${colors.dot}`} />
                        {need}
                      </li>
                    ))}
                  </ul>
                </div>

                {/* How It Helps */}
                <div className={`${colors.bg} rounded-xl p-4`}>
                  <h4 className={`text-sm font-semibold ${colors.text} mb-2`}>
                    {t.personas.howItHelpsLabel}
                  </h4>
                  <p className="text-foreground/80 text-sm">
                    {persona.howItHelps}
                  </p>
                </div>
              </Card>
            )
          })}
        </div>

        {/* Note */}
        <div className="mt-12 text-center">
          <p className="text-muted-foreground text-sm max-w-xl mx-auto">
            {t.personas.note}
          </p>
        </div>
      </div>
    </section>
  )
}
