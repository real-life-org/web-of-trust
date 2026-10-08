import { UserCheck, Share2, Award, ArrowRight } from 'lucide-react'
import { Card } from '@real-life/toolkit'
import { useLanguage } from '../i18n/LanguageContext'

const colorClasses = {
  primary: {
    bg: 'bg-primary/10',
    text: 'text-primary',
    border: 'border-primary/20',
    gradient: 'from-primary to-primary/80',
  },
  secondary: {
    bg: 'bg-secondary/10',
    text: 'text-secondary',
    border: 'border-secondary/20',
    gradient: 'from-secondary to-secondary/80',
  },
  accent: {
    bg: 'bg-warning/10',
    text: 'text-warning',
    border: 'border-warning/20',
    gradient: 'from-warning to-warning/80',
  },
}

export default function ProblemSolution() {
  const { t } = useLanguage()

  const problems = [
    { before: t.problemSolution.problems[0].before, after: t.problemSolution.problems[0].after },
    { before: t.problemSolution.problems[1].before, after: t.problemSolution.problems[1].after },
    { before: t.problemSolution.problems[2].before, after: t.problemSolution.problems[2].after },
    { before: t.problemSolution.problems[3].before, after: t.problemSolution.problems[3].after },
    { before: t.problemSolution.problems[4].before, after: t.problemSolution.problems[4].after },
  ]

  const pillars = [
    {
      icon: UserCheck,
      title: t.problemSolution.pillars[0].title,
      description: t.problemSolution.pillars[0].description,
      color: 'primary',
      detail: t.problemSolution.pillars[0].detail,
    },
    {
      icon: Share2,
      title: t.problemSolution.pillars[1].title,
      description: t.problemSolution.pillars[1].description,
      color: 'secondary',
      detail: t.problemSolution.pillars[1].detail,
    },
    {
      icon: Award,
      title: t.problemSolution.pillars[2].title,
      description: t.problemSolution.pillars[2].description,
      color: 'accent',
      detail: t.problemSolution.pillars[2].detail,
    },
  ]

  return (
    <section id="konzept" className="py-16 md:py-24 bg-background">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-foreground mb-4">
            {t.problemSolution.title}
          </h2>
          <p className="text-lg text-muted-foreground leading-relaxed max-w-2xl mx-auto">
            {t.problemSolution.subtitle}
          </p>
        </div>

        {/* Problem/Solution Comparison */}
        <div className="mb-20">
          <div className="grid grid-cols-2 gap-4 max-w-4xl mx-auto">
            <div className="text-center md:text-right">
              <h3 className="text-sm font-semibold text-muted-foreground/70 uppercase tracking-wider mb-4">{t.problemSolution.today}</h3>
            </div>
            <div className="text-center md:text-left">
              <h3 className="text-sm font-semibold text-secondary uppercase tracking-wider mb-4">{t.problemSolution.better}</h3>
            </div>
          </div>

          <div className="space-y-3 max-w-4xl mx-auto">
            {problems.map((item, index) => (
              <div key={index} className="grid grid-cols-2 gap-4 items-center">
                <div className="bg-muted rounded-lg p-3 md:p-4 text-center md:text-right">
                  <span className="text-muted-foreground text-sm md:text-base">{item.before}</span>
                </div>
                <div className="bg-secondary/5 rounded-lg p-3 md:p-4 text-center md:text-left border border-secondary/20">
                  <span className="text-secondary font-medium text-sm md:text-base">{item.after}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Three Pillars */}
        <div className="mb-12">
          <h3 className="text-xl md:text-2xl font-semibold text-center text-foreground mb-12">
            {t.problemSolution.pillarsTitle}
          </h3>

          <div className="grid md:grid-cols-3 gap-8">
            {pillars.map((pillar, index) => {
              const colors = colorClasses[pillar.color]
              const Icon = pillar.icon

              return (
                <div key={index} className="relative">
                  {/* Connector Arrow (except last) */}
                  {index < pillars.length - 1 && (
                    <div className="hidden md:block absolute top-1/2 -translate-y-1/2 -right-4 translate-x-1/2 z-10">
                      <ArrowRight className="text-muted-foreground/30" size={24} />
                    </div>
                  )}

                  <Card className={`px-6 gap-0 ${colors.border} h-full`}>
                    <div className={`w-14 h-14 ${colors.bg} rounded-xl flex items-center justify-center mb-4`}>
                      <Icon className={colors.text} size={28} />
                    </div>
                    <h4 className="text-xl font-semibold text-foreground mb-2">
                      {pillar.title}
                    </h4>
                    <p className={`${colors.text} font-medium mb-3`}>
                      {pillar.description}
                    </p>
                    <p className="text-muted-foreground text-sm">
                      {pillar.detail}
                    </p>
                  </Card>
                </div>
              )
            })}
          </div>
        </div>

        {/* Important Note */}
        <div className="max-w-2xl mx-auto">
          <div className="bg-primary/5 border border-primary/20 rounded-xl p-6 text-center">
            <h4 className="font-semibold text-primary mb-2">
              {t.problemSolution.note.title}
            </h4>
            <p className="text-primary/80">
              {t.problemSolution.note.text}
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
