import { QrCode, Eye, BadgeCheck, CheckCircle2 } from 'lucide-react'
import { Card } from '@real-life-stack/toolkit'
import { useLanguage } from '../i18n/LanguageContext'

const colorClasses = {
  primary: {
    bg: 'bg-primary',
    light: 'bg-primary/10',
    text: 'text-primary',
    border: 'border-primary',
  },
  secondary: {
    bg: 'bg-secondary',
    light: 'bg-secondary/10',
    text: 'text-secondary',
    border: 'border-secondary',
  },
  accent: {
    bg: 'bg-warning',
    light: 'bg-warning/10',
    text: 'text-warning',
    border: 'border-warning',
  },
}

export default function HowItWorks() {
  const { t } = useLanguage()

  const steps = [
    {
      number: '01',
      icon: QrCode,
      title: t.howItWorks.steps[0].title,
      description: t.howItWorks.steps[0].description,
      detail: t.howItWorks.steps[0].detail,
      color: 'primary',
    },
    {
      number: '02',
      icon: CheckCircle2,
      title: t.howItWorks.steps[1].title,
      description: t.howItWorks.steps[1].description,
      detail: t.howItWorks.steps[1].detail,
      color: 'primary',
    },
    {
      number: '03',
      icon: Eye,
      title: t.howItWorks.steps[2].title,
      description: t.howItWorks.steps[2].description,
      detail: t.howItWorks.steps[2].detail,
      color: 'secondary',
    },
    {
      number: '04',
      icon: BadgeCheck,
      title: t.howItWorks.steps[3].title,
      description: t.howItWorks.steps[3].description,
      detail: t.howItWorks.steps[3].detail,
      color: 'accent',
    },
  ]

  return (
    <>
    <section id="how-it-works" className="py-16 md:py-24 bg-muted">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-foreground mb-4">
            {t.howItWorks.title}
          </h2>
          <p className="text-lg text-muted-foreground leading-relaxed max-w-2xl mx-auto">
            {t.howItWorks.subtitle}
          </p>
        </div>

        {/* Steps */}
        <div className="max-w-4xl mx-auto">
          <div className="grid md:grid-cols-2 gap-6">
              {steps.map((step, index) => {
                const colors = colorClasses[step.color]
                const Icon = step.icon
                const isEven = index % 2 === 0

                return (
                  <div key={index} className="relative pt-8">
                    {/* Icon überlappt die Karte */}
                    <div className={`absolute top-0 md:left-4 ${isEven ? 'left-4' : 'right-4'} z-10`}>
                      <div className={`w-16 h-16 ${colors.bg} rounded-2xl flex items-center justify-center text-primary-foreground shadow-lg`}>
                        <Icon size={32} />
                      </div>
                    </div>

                    <Card className="px-6 gap-0 pt-14!">
                      <span className={`text-sm font-bold ${colors.text}`}>
                        {t.howItWorks.step} {step.number}
                      </span>
                      <h3 className="text-xl font-semibold text-foreground mt-1 mb-3">
                        {step.title}
                      </h3>
                      <p className="text-muted-foreground mb-3">
                        {step.description}
                      </p>
                      <p className="text-sm text-muted-foreground/70 border-t border-border pt-3">
                        {step.detail}
                      </p>
                    </Card>
                  </div>
                )
              })}
          </div>
        </div>

      </div>
    </section>

    {/* Network Result Section */}
    <section className="pt-0 pb-16 md:pb-24 bg-muted">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="max-w-4xl mx-auto">
          {/* Text above graph */}
          <div className="text-center mb-6">
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-foreground mb-4">
              {t.howItWorks.result.title}
            </h2>
            <p className="text-lg text-muted-foreground leading-relaxed max-w-2xl mx-auto">
              {t.howItWorks.result.text}
            </p>
          </div>

          {/* Network Animation — heartbeat spreads through nodes */}
          <svg className="w-full h-48 md:h-64 dark:brightness-150" viewBox="0 0 800 240" fill="none">
            <defs>
              {/* Primary blue glow */}
              <radialGradient id="glowPrimary">
                <stop offset="0%" stopColor="oklch(0.55 0.21 264)" stopOpacity="0.35" />
                <stop offset="100%" stopColor="oklch(0.55 0.21 264)" stopOpacity="0" />
              </radialGradient>
              {/* Secondary green glow */}
              <radialGradient id="glowSecondary">
                <stop offset="0%" stopColor="oklch(0.55 0.17 142)" stopOpacity="0.35" />
                <stop offset="100%" stopColor="oklch(0.55 0.17 142)" stopOpacity="0" />
              </radialGradient>
              {/* Warning amber glow */}
              <radialGradient id="glowWarning">
                <stop offset="0%" stopColor="oklch(0.70 0.17 55)" stopOpacity="0.35" />
                <stop offset="100%" stopColor="oklch(0.70 0.17 55)" stopOpacity="0" />
              </radialGradient>
            </defs>

            {/* Links — neutral color */}
            <g stroke="currentColor" strokeWidth="1" className="text-foreground/15">
              {/* Core network */}
              <line x1="120" y1="100" x2="260" y2="65" />
              <line x1="260" y1="65" x2="400" y2="120" />
              <line x1="400" y1="120" x2="540" y2="75" />
              <line x1="540" y1="75" x2="660" y2="110" />
              <line x1="120" y1="100" x2="190" y2="170" />
              <line x1="260" y1="65" x2="190" y2="170" />
              <line x1="260" y1="65" x2="310" y2="170" />
              <line x1="400" y1="120" x2="310" y2="170" />
              <line x1="400" y1="120" x2="500" y2="180" />
              <line x1="540" y1="75" x2="500" y2="180" />
              <line x1="310" y1="170" x2="500" y2="180" />
              <line x1="190" y1="170" x2="310" y2="170" />
              <line x1="120" y1="100" x2="80" y2="45" />
              <line x1="80" y1="45" x2="260" y2="65" />
              <line x1="400" y1="120" x2="450" y2="45" />
              <line x1="450" y1="45" x2="540" y2="75" />
              <line x1="260" y1="65" x2="450" y2="45" />
              <line x1="660" y1="110" x2="610" y2="175" />
              <line x1="540" y1="75" x2="610" y2="175" />
              <line x1="500" y1="180" x2="610" y2="175" />
              {/* Open ends */}
              <line x1="120" y1="100" x2="40" y2="80" />
              <line x1="120" y1="100" x2="60" y2="150" />
              <line x1="80" y1="45" x2="50" y2="15" />
              <line x1="260" y1="65" x2="220" y2="15" />
              <line x1="450" y1="45" x2="430" y2="10" />
              <line x1="540" y1="75" x2="580" y2="20" />
              <line x1="660" y1="110" x2="740" y2="90" />
              <line x1="660" y1="110" x2="730" y2="150" />
              <line x1="610" y1="175" x2="670" y2="220" />
              <line x1="190" y1="170" x2="140" y2="220" />
              <line x1="310" y1="170" x2="320" y2="225" />
              <line x1="500" y1="180" x2="530" y2="230" />
              <line x1="500" y1="180" x2="440" y2="225" />
            </g>

            {/* Nodes — open ends (small, fading) — mixed colors */}
            <circle cx="40" cy="80" r="4" className="fill-secondary" opacity="0.15" />
            <circle cx="60" cy="150" r="3.5" className="fill-warning" opacity="0.12" />
            <circle cx="50" cy="15" r="3.5" className="fill-warning" opacity="0.12" />
            <circle cx="220" cy="15" r="4" className="fill-secondary" opacity="0.15" />
            <circle cx="430" cy="10" r="3.5" className="fill-primary" opacity="0.12" />
            <circle cx="580" cy="20" r="4" className="fill-warning" opacity="0.15" />
            <circle cx="740" cy="90" r="4" className="fill-primary" opacity="0.12" />
            <circle cx="730" cy="150" r="3.5" className="fill-secondary" opacity="0.12" />
            <circle cx="670" cy="220" r="3.5" className="fill-primary" opacity="0.1" />
            <circle cx="140" cy="220" r="3.5" className="fill-warning" opacity="0.1" />
            <circle cx="320" cy="225" r="3.5" className="fill-secondary" opacity="0.1" />
            <circle cx="440" cy="225" r="3.5" className="fill-primary" opacity="0.1" />
            <circle cx="530" cy="230" r="3.5" className="fill-warning" opacity="0.1" />

            {/* Nodes — inner: bg circle + colored circle — mixed colors */}
            <circle cx="80" cy="45" r="9" className="fill-muted" />
            <circle cx="80" cy="45" r="6" className="fill-warning" opacity="0.3" />
            <circle cx="190" cy="170" r="9" className="fill-muted" />
            <circle cx="190" cy="170" r="6" className="fill-secondary" opacity="0.3" />
            <circle cx="310" cy="170" r="9" className="fill-muted" />
            <circle cx="310" cy="170" r="6" className="fill-warning" opacity="0.3" />
            <circle cx="450" cy="45" r="9" className="fill-muted" />
            <circle cx="450" cy="45" r="6" className="fill-primary" opacity="0.3" />
            <circle cx="500" cy="180" r="9" className="fill-muted" />
            <circle cx="500" cy="180" r="6" className="fill-primary" opacity="0.3" />
            <circle cx="610" cy="175" r="9" className="fill-muted" />
            <circle cx="610" cy="175" r="6" className="fill-secondary" opacity="0.3" />

            {/* Nodes — main: bg circle + colored circle — mixed colors */}
            <circle cx="120" cy="100" r="12" className="fill-muted" />
            <circle cx="120" cy="100" r="8" className="fill-primary" opacity="0.4" />
            <circle cx="260" cy="65" r="13" className="fill-muted" />
            <circle cx="260" cy="65" r="9" className="fill-secondary" opacity="0.45" />
            <circle cx="400" cy="120" r="14" className="fill-muted" />
            <circle cx="400" cy="120" r="10" className="fill-warning" opacity="0.5" />
            <circle cx="540" cy="75" r="13" className="fill-muted" />
            <circle cx="540" cy="75" r="9" className="fill-primary" opacity="0.45" />
            <circle cx="660" cy="110" r="12" className="fill-muted" />
            <circle cx="660" cy="110" r="8" className="fill-secondary" opacity="0.4" />

            {/*
              Heartbeat chain: 12s cycle, keyTimes approach
              Colors matched to resting node colors (randomly mixed):
              A(120,100)=primary, B(260,65)=secondary, C(400,120)=warning,
              D(540,75)=primary, E(660,110)=secondary
              Inner ripples match their own resting color.
            */}

            {/* === Node A (120,100) — PRIMARY (blue) === */}
            <circle cx="120" cy="100" r="8" fill="oklch(0.55 0.21 264)" opacity="0">
              <animate attributeName="opacity" dur="12s" repeatCount="indefinite"
                keyTimes="0;0.042;0.083;1" values="0;0.8;0;0" />
              <animate attributeName="r" dur="12s" repeatCount="indefinite"
                keyTimes="0;0.042;0.083;1" values="8;12;8;8" />
            </circle>
            <circle cx="120" cy="100" r="8" fill="none" stroke="oklch(0.55 0.21 264)" strokeWidth="1" opacity="0">
              <animate attributeName="r" dur="12s" repeatCount="indefinite"
                keyTimes="0;0.083;0.084;1" values="8;28;8;8" />
              <animate attributeName="opacity" dur="12s" repeatCount="indefinite"
                keyTimes="0;0.083;0.084;1" values="0.3;0;0;0" />
            </circle>

            {/* Inner (80,45) warning — ripples after A */}
            <circle cx="80" cy="45" r="6" fill="oklch(0.70 0.17 55)" opacity="0">
              <animate attributeName="opacity" dur="12s" repeatCount="indefinite"
                keyTimes="0;0.058;0.083;0.117;1" values="0;0;0.35;0;0" />
            </circle>
            {/* Inner (190,170) secondary — ripples after A */}
            <circle cx="190" cy="170" r="6" fill="oklch(0.55 0.17 142)" opacity="0">
              <animate attributeName="opacity" dur="12s" repeatCount="indefinite"
                keyTimes="0;0.067;0.092;0.125;1" values="0;0;0.35;0;0" />
            </circle>

            {/* === Node B (260,65) — SECONDARY (green) === */}
            <circle cx="260" cy="65" r="9" fill="oklch(0.55 0.17 142)" opacity="0">
              <animate attributeName="opacity" dur="12s" repeatCount="indefinite"
                keyTimes="0;0.167;0.208;0.25;1" values="0;0;0.8;0;0" />
              <animate attributeName="r" dur="12s" repeatCount="indefinite"
                keyTimes="0;0.167;0.208;0.25;1" values="9;9;13;9;9" />
            </circle>
            <circle cx="260" cy="65" r="9" fill="none" stroke="oklch(0.55 0.17 142)" strokeWidth="1" opacity="0">
              <animate attributeName="r" dur="12s" repeatCount="indefinite"
                keyTimes="0;0.167;0.25;0.251;1" values="9;9;30;9;9" />
              <animate attributeName="opacity" dur="12s" repeatCount="indefinite"
                keyTimes="0;0.167;0.25;0.251;1" values="0;0.3;0;0;0" />
            </circle>

            {/* Inner (310,170) warning — ripples after B */}
            <circle cx="310" cy="170" r="6" fill="oklch(0.70 0.17 55)" opacity="0">
              <animate attributeName="opacity" dur="12s" repeatCount="indefinite"
                keyTimes="0;0.233;0.258;0.292;1" values="0;0;0.35;0;0" />
            </circle>
            {/* Inner (450,45) primary — ripples after B */}
            <circle cx="450" cy="45" r="6" fill="oklch(0.55 0.21 264)" opacity="0">
              <animate attributeName="opacity" dur="12s" repeatCount="indefinite"
                keyTimes="0;0.233;0.258;0.292;1" values="0;0;0.35;0;0" />
            </circle>

            {/* === Node C (400,120) — WARNING (amber), center === */}
            <circle cx="400" cy="120" r="10" fill="oklch(0.70 0.17 55)" opacity="0">
              <animate attributeName="opacity" dur="12s" repeatCount="indefinite"
                keyTimes="0;0.333;0.375;0.417;1" values="0;0;0.9;0;0" />
              <animate attributeName="r" dur="12s" repeatCount="indefinite"
                keyTimes="0;0.333;0.375;0.417;1" values="10;10;15;10;10" />
            </circle>
            <circle cx="400" cy="120" r="10" fill="none" stroke="oklch(0.70 0.17 55)" strokeWidth="1" opacity="0">
              <animate attributeName="r" dur="12s" repeatCount="indefinite"
                keyTimes="0;0.333;0.417;0.418;1" values="10;10;35;10;10" />
              <animate attributeName="opacity" dur="12s" repeatCount="indefinite"
                keyTimes="0;0.333;0.417;0.418;1" values="0;0.35;0;0;0" />
            </circle>
            <circle cx="400" cy="120" r="22" fill="url(#glowWarning)" opacity="0">
              <animate attributeName="opacity" dur="12s" repeatCount="indefinite"
                keyTimes="0;0.333;0.375;0.417;1" values="0;0;0.4;0;0" />
            </circle>

            {/* === Node D (540,75) — PRIMARY (blue) === */}
            <circle cx="540" cy="75" r="9" fill="oklch(0.55 0.21 264)" opacity="0">
              <animate attributeName="opacity" dur="12s" repeatCount="indefinite"
                keyTimes="0;0.5;0.542;0.583;1" values="0;0;0.8;0;0" />
              <animate attributeName="r" dur="12s" repeatCount="indefinite"
                keyTimes="0;0.5;0.542;0.583;1" values="9;9;13;9;9" />
            </circle>
            <circle cx="540" cy="75" r="9" fill="none" stroke="oklch(0.55 0.21 264)" strokeWidth="1" opacity="0">
              <animate attributeName="r" dur="12s" repeatCount="indefinite"
                keyTimes="0;0.5;0.583;0.584;1" values="9;9;30;9;9" />
              <animate attributeName="opacity" dur="12s" repeatCount="indefinite"
                keyTimes="0;0.5;0.583;0.584;1" values="0;0.3;0;0;0" />
            </circle>

            {/* Inner (500,180) primary — ripples after D */}
            <circle cx="500" cy="180" r="6" fill="oklch(0.55 0.21 264)" opacity="0">
              <animate attributeName="opacity" dur="12s" repeatCount="indefinite"
                keyTimes="0;0.567;0.592;0.625;1" values="0;0;0.35;0;0" />
            </circle>
            {/* Inner (610,175) secondary — ripples after D */}
            <circle cx="610" cy="175" r="6" fill="oklch(0.55 0.17 142)" opacity="0">
              <animate attributeName="opacity" dur="12s" repeatCount="indefinite"
                keyTimes="0;0.575;0.6;0.633;1" values="0;0;0.35;0;0" />
            </circle>

            {/* === Node E (660,110) — SECONDARY (green) === */}
            <circle cx="660" cy="110" r="8" fill="oklch(0.55 0.17 142)" opacity="0">
              <animate attributeName="opacity" dur="12s" repeatCount="indefinite"
                keyTimes="0;0.667;0.708;0.75;1" values="0;0;0.7;0;0" />
              <animate attributeName="r" dur="12s" repeatCount="indefinite"
                keyTimes="0;0.667;0.708;0.75;1" values="8;8;12;8;8" />
            </circle>
            <circle cx="660" cy="110" r="8" fill="none" stroke="oklch(0.55 0.17 142)" strokeWidth="1" opacity="0">
              <animate attributeName="r" dur="12s" repeatCount="indefinite"
                keyTimes="0;0.667;0.75;0.751;1" values="8;8;26;8;8" />
              <animate attributeName="opacity" dur="12s" repeatCount="indefinite"
                keyTimes="0;0.667;0.75;0.751;1" values="0;0.3;0;0;0" />
            </circle>
          </svg>
        </div>
      </div>
    </section>
    </>
  )
}
