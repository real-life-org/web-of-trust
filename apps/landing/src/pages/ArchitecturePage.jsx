import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeft,
  Key,
  Users,
  Smartphone,
  Shield,
  Server,
  CheckCircle2,
  Clock,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Lock,
  Eye,
  Replace,
  Power,
  HardDrive,
  ShieldCheck,
  Mailbox,
  ArrowRightLeft,
  Blocks,
} from 'lucide-react'
import { Card } from '@real-life-stack/toolkit'
import { useLanguage } from '../i18n/LanguageContext'
import { translations } from '../i18n/translations'
import Header from '../components/Header'
import Footer from '../components/Footer'

const pillarIcons = [Key, Users, Smartphone]
const pillarColors = [
  { bg: 'bg-primary/10', text: 'text-primary', border: 'border-primary/20' },
  { bg: 'bg-secondary/10', text: 'text-secondary', border: 'border-secondary/20' },
  { bg: 'bg-warning/10', text: 'text-warning', border: 'border-warning/20' },
]
const localFirstIcons = [HardDrive, ShieldCheck, Mailbox]
const localFirstColors = [
  { bg: 'bg-primary/10', text: 'text-primary' },
  { bg: 'bg-secondary/10', text: 'text-secondary' },
  { bg: 'bg-warning/10', text: 'text-warning' },
]
const protectionColors = [
  { bg: 'bg-warning/10', text: 'text-warning' },
  { bg: 'bg-primary/10', text: 'text-primary' },
  { bg: 'bg-secondary/10', text: 'text-secondary' },
  { bg: 'bg-warning/10', text: 'text-warning' },
]

const statusColors = {
  decentralized: { bg: 'bg-green-500/10', text: 'text-green-600', dot: 'bg-green-500' },
  server: { bg: 'bg-amber-500/10', text: 'text-amber-600', dot: 'bg-amber-500' },
  manual: { bg: 'bg-muted', text: 'text-muted-foreground', dot: 'bg-muted-foreground' },
  wot: { bg: 'bg-primary/10', text: 'text-primary', dot: 'bg-primary' },
}

const protectionIcons = [Eye, Shield, Replace, Power]

export default function ArchitecturePage() {
  const { t } = useLanguage()
  // Fall back to EN if the current language doesn't have architecture translations
  const arch = t.architecture || translations.en.architecture
  const [openFaq, setOpenFaq] = useState({})

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Header />
      <main className="flex-1 pt-24 pb-16">
        {/* Hero */}
        <section className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 mb-16">
          <Link
            to="/"
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-primary transition-colors mb-8"
          >
            <ArrowLeft size={16} />
            {arch.backToHome}
          </Link>
          <h1 className="text-3xl md:text-5xl font-bold tracking-tight text-foreground mb-4">
            {arch.title}
          </h1>
          <p className="text-lg md:text-xl text-muted-foreground leading-relaxed max-w-2xl">
            {arch.subtitle}
          </p>
        </section>

        {/* Three Pillars */}
        <section className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 mb-20">
          <h2 className="text-2xl font-bold text-foreground mb-8">{arch.pillars.title}</h2>
          <div className="grid gap-6">
            {arch.pillars.items.map((pillar, i) => {
              const Icon = pillarIcons[i]
              const colors = pillarColors[i]
              return (
                <Card key={i} className="px-6 gap-0">
                  <div className="flex items-start gap-4">
                    <div className={`w-12 h-12 ${colors.bg} rounded-xl flex items-center justify-center shrink-0`}>
                      <Icon className={colors.text} size={24} />
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold text-foreground mb-2">{pillar.title}</h3>
                      <p className="text-muted-foreground mb-3">{pillar.description}</p>
                      <p className={`text-sm text-muted-foreground/80 border-l-2 ${colors.border} pl-3`}>
                        {pillar.technical}
                      </p>
                    </div>
                  </div>
                </Card>
              )
            })}
          </div>
        </section>

        {/* Decentralized vs Server */}
        <section className="bg-muted py-16 mb-20">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
            <h2 className="text-2xl font-bold text-foreground mb-10">{arch.decentralized.title}</h2>

            {/* Fully Decentralized */}
            <div className="mb-10">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-8 h-8 bg-green-500/10 rounded-lg flex items-center justify-center">
                  <CheckCircle2 className="text-green-600" size={18} />
                </div>
                <div>
                  <h3 className="font-semibold text-foreground">{arch.decentralized.fullyDecentralized.title}</h3>
                  <p className="text-sm text-muted-foreground">{arch.decentralized.fullyDecentralized.subtitle}</p>
                </div>
              </div>
              <div className="space-y-3">
                {arch.decentralized.fullyDecentralized.items.map((item, i) => (
                  <div key={i} className="bg-background rounded-lg p-4 border border-border">
                    <div className="flex items-baseline gap-2 mb-1">
                      <span className="font-medium text-foreground">{item.what}</span>
                      <span className="text-sm text-primary font-mono">{item.how}</span>
                    </div>
                    <p className="text-sm text-muted-foreground">{item.detail}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Server as Helper */}
            <div className="mb-10">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-8 h-8 bg-amber-500/10 rounded-lg flex items-center justify-center">
                  <Server className="text-amber-600" size={18} />
                </div>
                <div>
                  <h3 className="font-semibold text-foreground">{arch.decentralized.serverAsHelper.title}</h3>
                  <p className="text-sm text-muted-foreground">{arch.decentralized.serverAsHelper.subtitle}</p>
                </div>
              </div>
              <div className="space-y-3">
                {arch.decentralized.serverAsHelper.items.map((item, i) => (
                  <div key={i} className="bg-background rounded-lg p-4 border border-border">
                    <div className="flex items-baseline gap-2 mb-1">
                      <span className="font-medium text-foreground">{item.what}</span>
                      <span className="text-sm text-muted-foreground">— {item.description}</span>
                    </div>
                    <p className="text-sm text-muted-foreground mb-2">{item.why}</p>
                    <div className="flex flex-col sm:flex-row gap-2 text-xs">
                      <span className="bg-green-500/10 text-green-600 px-2 py-1 rounded">
                        <Lock size={12} className="inline mr-1" />
                        {item.protection}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground/70 mt-2 flex items-center gap-1">
                      <ChevronRight size={12} />
                      {item.roadmap}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            {/* Planned */}
            <div>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-8 h-8 bg-muted rounded-lg flex items-center justify-center border border-border">
                  <Clock className="text-muted-foreground" size={18} />
                </div>
                <div>
                  <h3 className="font-semibold text-foreground">{arch.decentralized.planned.title}</h3>
                  <p className="text-sm text-muted-foreground">{arch.decentralized.planned.subtitle}</p>
                </div>
              </div>
              <div className="space-y-3">
                {arch.decentralized.planned.items.map((item, i) => (
                  <div key={i} className="bg-background rounded-lg p-4 border border-border">
                    <div className="flex items-baseline gap-2 mb-1">
                      <span className="font-medium text-foreground">{item.what}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${
                        item.status.includes('NLNet') || item.status.includes('Finanziert') || item.status.includes('Funded')
                          ? 'bg-green-500/10 text-green-600'
                          : 'bg-muted text-muted-foreground'
                      }`}>
                        {item.status}
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground">{item.goal}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Local-First */}
        <section className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 mb-20">
          <h2 className="text-2xl font-bold text-foreground mb-4">{arch.localFirst.title}</h2>
          <p className="text-lg text-muted-foreground mb-8">{arch.localFirst.intro}</p>

          <div className="grid sm:grid-cols-3 gap-4 mb-8">
            {arch.localFirst.items.map((item, i) => {
              const Icon = localFirstIcons[i]
              const colors = localFirstColors[i]
              return (
                <div key={i} className="bg-muted rounded-xl p-5 border border-border">
                  <div className={`w-10 h-10 ${colors.bg} rounded-lg flex items-center justify-center mb-3`}>
                    <Icon className={colors.text} size={20} />
                  </div>
                  <h3 className="font-semibold text-foreground mb-2">{item.title}</h3>
                  <p className="text-sm text-muted-foreground">{item.description}</p>
                </div>
              )
            })}
          </div>

          <div className="bg-foreground dark:bg-card rounded-2xl p-6 md:p-8 text-background dark:text-foreground">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 bg-primary/20 rounded-xl flex items-center justify-center shrink-0">
                <ArrowRightLeft className="text-primary" size={20} />
              </div>
              <div>
                <h3 className="text-lg font-bold mb-2">{arch.localFirst.bridge.title}</h3>
                <p className="text-background/80 dark:text-muted-foreground">{arch.localFirst.bridge.description}</p>
              </div>
            </div>
          </div>
        </section>

        {/* Adapter Architecture */}
        {arch.adapters && (
          <section className="bg-muted py-16 mb-20">
            <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
              <h2 className="text-2xl font-bold text-foreground mb-4">{arch.adapters.title}</h2>
              <p className="text-lg text-muted-foreground mb-8">{arch.adapters.intro}</p>

              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
                {arch.adapters.items.map((adapter, i) => (
                  <div key={i} className="bg-background rounded-lg p-4 border border-border">
                    <div className="flex items-center gap-3 mb-2">
                      <span className="text-sm font-mono text-primary">{adapter.name}</span>
                    </div>
                    <p className="text-sm text-muted-foreground">{adapter.description}</p>
                    {adapter.current && (
                      <p className="text-xs text-muted-foreground/70 mt-2 border-t border-border pt-2">
                        Aktuell: {adapter.link ? (
                          <a href={adapter.link} target="_blank" rel="noopener noreferrer" className="font-mono text-primary hover:underline">
                            {adapter.current}
                          </a>
                        ) : (
                          <span className="font-mono">{adapter.current}</span>
                        )}
                      </p>
                    )}
                  </div>
                ))}
              </div>

              <p className="text-sm text-muted-foreground/80 text-center">
                {arch.adapters.footer}
              </p>
            </div>
          </section>
        )}

        {/* Server Protection */}
        <section className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 mb-20">
          <h2 className="text-2xl font-bold text-foreground mb-4">{arch.serverProtection.title}</h2>
          <p className="text-lg text-muted-foreground italic mb-2">{arch.serverProtection.question}</p>
          <p className="text-lg text-foreground font-medium mb-8">{arch.serverProtection.answer}</p>

          <div className="grid sm:grid-cols-2 gap-4 mb-10">
            {arch.serverProtection.reasons.map((reason, i) => {
              const Icon = protectionIcons[i]
              const colors = protectionColors[i]
              return (
                <Card key={i} className="px-5 gap-0">
                  <div className="flex items-start gap-3">
                    <div className={`w-8 h-8 ${colors.bg} rounded-lg flex items-center justify-center shrink-0 mt-0.5`}>
                      <Icon className={colors.text} size={16} />
                    </div>
                    <div>
                      <h4 className="font-semibold text-foreground text-sm mb-1">{reason.title}</h4>
                      <p className="text-sm text-muted-foreground">{reason.description}</p>
                    </div>
                  </div>
                </Card>
              )
            })}
          </div>

          {/* Comparison */}
          <h3 className="font-bold text-foreground mb-4">{arch.serverProtection.comparison.title}</h3>
          <div className="grid sm:grid-cols-3 gap-4">
            {arch.serverProtection.comparison.items.map((item, i) => {
              const isWot = item.name === 'Web of Trust'
              return (
                <div
                  key={i}
                  className={`rounded-xl p-5 text-center ${
                    isWot
                      ? 'bg-primary/10 border-2 border-primary/30 ring-1 ring-primary/10'
                      : 'bg-muted border border-border'
                  }`}
                >
                  <div className="flex justify-center mb-3">
                    {item.name === 'Signal' && (
                      <svg viewBox="0 0 1024 1024" className="w-12 h-12 rounded-xl" xmlns="http://www.w3.org/2000/svg">
                        <rect width="1024" height="1024" rx="180" fill="#3a76f0"/>
                        <path fill="#ffffff" d="M427.5,170.3l7.9,32A319.6,319.6,0,0,0,347,238.9l-16.9-28.3A347.6,347.6,0,0,1,427.5,170.3Zm169,0-7.9,32A319.6,319.6,0,0,1,677,238.9l17.1-28.3A350.1,350.1,0,0,0,596.5,170.3ZM210.6,330a349.5,349.5,0,0,0-40.3,97.5l32,7.9A319.6,319.6,0,0,1,238.9,347ZM193,512a318.5,318.5,0,0,1,3.6-47.8l-32.6-5a352,352,0,0,0,0,105.5l32.6-4.9A319.5,319.5,0,0,1,193,512ZM693.9,813.3,677,785.1a317.8,317.8,0,0,1-88.3,36.6l7.9,32A350.3,350.3,0,0,0,693.9,813.3ZM831,512a319.5,319.5,0,0,1-3.6,47.8l32.6,4.9a352,352,0,0,0,0-105.5l-32.6,5A318.5,318.5,0,0,1,831,512Zm22.7,84.4-32-7.9A319,319,0,0,1,785.1,677l28.3,17A348.9,348.9,0,0,0,853.7,596.4Zm-293.9,231a319.1,319.1,0,0,1-95.6,0L459.3,860a351.3,351.3,0,0,0,105.4,0Zm209-126.2a318.1,318.1,0,0,1-67.6,67.5l19.6,26.6A355.1,355.1,0,0,0,795.4,721Zm-67.6-446a318.6,318.6,0,0,1,67.6,67.6L795.4,303A354.6,354.6,0,0,0,721,228.6Zm-446,67.6a318.6,318.6,0,0,1,67.6-67.6L303,228.6A354.6,354.6,0,0,0,228.6,303ZM813.4,330l-28.3,17a317.8,317.8,0,0,1,36.6,88.3l32-7.9A348.9,348.9,0,0,0,813.4,330ZM464.2,196.6a319.1,319.1,0,0,1,95.6,0l4.9-32.6a351.3,351.3,0,0,0-105.4,0ZM272.1,804.1,204,819.9l15.9-68.1-32.1-7.5-15.9,68.1a33,33,0,0,0,24.6,39.7,34.5,34.5,0,0,0,15,0l68.1-15.7Zm-77.5-89.2,32.2,7.4,11-47.2a316.2,316.2,0,0,1-35.5-86.6l-32,7.9a353.3,353.3,0,0,0,32.4,83.7Zm154,71.4-47.2,11,7.5,32.2,34.7-8.1a349,349,0,0,0,83.7,32.4l7.9-32a316.7,316.7,0,0,1-86.3-35.7ZM512,226c-158,.1-285.9,128.2-285.9,286.1a286.7,286.7,0,0,0,43.9,152L242.5,781.5,359.8,754c133.7,84.1,310.3,44,394.4-89.6S798.3,354.2,664.7,270A286.7,286.7,0,0,0,512,226z"/>
                      </svg>
                    )}
                    {item.name === 'WhatsApp' && (
                      <svg viewBox="0 0 40 40" className="w-12 h-12 rounded-xl" xmlns="http://www.w3.org/2000/svg">
                        <rect width="40" height="40" rx="8" fill="#25d366"/>
                        <path fill="white" d="M20 9c-6.1 0-11 4.9-11 11 0 2 .5 3.8 1.5 5.5L9 31l5.6-1.5c1.6.9 3.4 1.3 5.4 1.3 6.1 0 11-4.9 11-11s-4.9-11-11-11zm6 15.7c-.3.7-1.5 1.4-2 1.5-.5.1-1.2.1-1.9-.1-.4-.2-1-.3-1.7-.7-3-1.3-5-4.5-5.1-4.6-.1-.2-1.2-1.6-1.2-3.1 0-1.5.8-2.2 1-2.5.3-.3.6-.3.8-.3h.6c.2 0 .4-.1.7.5.3.6.9 2.1.9 2.3.1.1.1.3 0 .5s-.2.3-.3.5c-.1.2-.3.4-.4.5-.2.2-.3.3-.1.6.2.3.8 1.3 1.7 2.2 1.2 1.1 2.1 1.4 2.4 1.6.3.1.5.1.7-.1.2-.2.7-.9 1-1.2.2-.3.4-.2.7-.1.3.1 1.7.8 2 1 .3.1.5.2.6.3.1.1.1.7-.2 1.4z"/>
                      </svg>
                    )}
                    {isWot && (
                      <div className="w-12 h-12 bg-primary rounded-xl flex items-center justify-center">
                        <svg viewBox="0 1 23 22" className="w-7 h-7 text-primary-foreground" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="18.72" cy="8.82" r="2.5" />
                          <circle cx="5.28" cy="5.28" r="2.5" />
                          <circle cx="8.82" cy="18.72" r="2.5" />
                          <line x1="6.04" x2="8.06" y1="8.18" y2="15.82" />
                          <line x1="15.81" x2="8.18" y1="8.05" y2="6.04" />
                          <line x1="16.59" x2="10.94" y1="10.94" y2="16.59" />
                        </svg>
                      </div>
                    )}
                  </div>
                  <h4 className={`font-semibold mb-1 ${isWot ? 'text-primary' : 'text-foreground'}`}>
                    {item.name}
                  </h4>
                  <p className="text-sm text-muted-foreground">{item.detail}</p>
                </div>
              )
            })}
          </div>
        </section>

        {/* Roadmap */}
        <section className="bg-muted py-16 mb-20">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
            <h2 className="text-2xl font-bold text-foreground mb-10">{arch.roadmap.title}</h2>

            {/* Phase Headers */}
            <div className="hidden md:grid grid-cols-[180px_1fr_1fr_1fr] gap-4 mb-4">
              <div />
              {['today', 'tomorrow', 'vision'].map((phase) => (
                <div key={phase} className="text-center">
                  <span className="text-sm font-bold text-foreground uppercase tracking-wider">
                    {arch.roadmap.phases[phase]}
                  </span>
                </div>
              ))}
            </div>

            {/* Categories */}
            <div className="space-y-3">
              {arch.roadmap.categories.map((cat, i) => (
                <div key={i} className="bg-background rounded-lg border border-border overflow-hidden">
                  {/* Desktop */}
                  <div className="hidden md:grid grid-cols-[180px_1fr_1fr_1fr] gap-4 p-4 items-center">
                    <span className="font-medium text-foreground">{cat.name}</span>
                    {['today', 'tomorrow', 'vision'].map((phase) => {
                      const cell = cat[phase]
                      const colors = statusColors[cell.status]
                      return (
                        <div key={phase} className="text-center">
                          <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full ${colors.bg}`}>
                            <div className={`w-2 h-2 rounded-full ${colors.dot}`} />
                            <span className={`text-sm font-medium ${colors.text}`}>{cell.label}</span>
                          </div>
                          {cell.detail && (
                            <p className="text-xs text-muted-foreground mt-1">{cell.detail}</p>
                          )}
                        </div>
                      )
                    })}
                  </div>
                  {/* Mobile */}
                  <div className="md:hidden p-4">
                    <span className="font-medium text-foreground block mb-3">{cat.name}</span>
                    <div className="space-y-2">
                      {['today', 'tomorrow', 'vision'].map((phase) => {
                        const cell = cat[phase]
                        const colors = statusColors[cell.status]
                        return (
                          <div key={phase} className="flex items-center gap-3">
                            <span className="text-xs text-muted-foreground w-16 shrink-0">
                              {arch.roadmap.phases[phase]}
                            </span>
                            <div className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full ${colors.bg}`}>
                              <div className={`w-1.5 h-1.5 rounded-full ${colors.dot}`} />
                              <span className={`text-xs font-medium ${colors.text}`}>{cell.label}</span>
                            </div>
                            {cell.detail && (
                              <span className="text-xs text-muted-foreground">{cell.detail}</span>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Legend */}
            <div className="flex flex-wrap gap-4 mt-6">
              {Object.entries(arch.roadmap.legend).map(([key, label]) => {
                const colors = statusColors[key]
                return (
                  <div key={key} className="flex items-center gap-2 text-sm text-muted-foreground">
                    <div className={`w-2.5 h-2.5 rounded-full ${colors.dot}`} />
                    {label}
                  </div>
                )
              })}
            </div>
          </div>
        </section>

        {/* Tech Badges */}
        <section className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 mb-20">
          <div className="flex flex-wrap gap-2 justify-center">
            {arch.techBadges.map((badge, i) => (
              <span
                key={i}
                className="px-3 py-1.5 bg-muted text-muted-foreground text-sm font-mono rounded-full border border-border"
              >
                {badge}
              </span>
            ))}
          </div>
        </section>

        {/* Architecture FAQ */}
        <section className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-2xl font-bold text-foreground mb-8">{arch.faq.title}</h2>
          <Card className="px-6 gap-0">
            {arch.faq.items.map((item, i) => (
              <div key={i} className="border-b border-border last:border-b-0">
                <button
                  className="w-full py-5 flex items-center justify-between text-left"
                  onClick={() => setOpenFaq(prev => ({ ...prev, [i]: !prev[i] }))}
                >
                  <span className="font-medium text-foreground pr-4">{item.q}</span>
                  {openFaq[i] ? (
                    <ChevronUp className="shrink-0 text-primary" size={20} />
                  ) : (
                    <ChevronDown className="shrink-0 text-muted-foreground" size={20} />
                  )}
                </button>
                {openFaq[i] && (
                  <div className="pb-5 pr-8">
                    <p className="text-muted-foreground">{item.a}</p>
                  </div>
                )}
              </div>
            ))}
          </Card>
        </section>
      </main>
      <Footer />
    </div>
  )
}
