// Pure panels of the scenario player (architecture §7.3), on the app's primitives. Every value and
// every action comes in as a prop; PlayerApp.tsx connects them to the player model. Developer
// tooling: English only, no i18n.
import type { ReactNode } from 'react'
import { Button, Input, Switch, Tabs, TabsList, TabsTrigger, cn } from '../../../src/ui/primitives'
import type { PlayerFaults } from '../../scenario'
import type { PlayerLang, PlayerTheme } from '../player'

export function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  const id = `sec-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`
  return (
    <section aria-labelledby={id} className={cn('flex flex-col gap-2 border-b border-border px-4 py-3', className)}>
      <h2 id={id} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  )
}

const selectClass =
  'h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring'

export interface Option {
  readonly value: string
  readonly label: string
}

export function SelectField({ label, value, options, onChange }: { label: string; value: string; options: readonly Option[]; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <select className={selectClass} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <Tabs value={value} onValueChange={(v) => onChange(v as T)} activationMode="manual">
        <TabsList aria-label={label}>
          {options.map((o) => (
            <TabsTrigger key={o.value} value={o.value} className="px-2 py-1">
              {o.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  )
}

export interface ClockPanelProps {
  /** formatted player time, or null before a phone attached */
  readonly now: string | null
  readonly behind: boolean
  readonly jumpValue: string
  readonly onJumpValue: (v: string) => void
  readonly onShift: (ms: number) => void
  readonly onJump: () => void
}

const SHIFTS: readonly { label: string; ms: number }[] = [
  { label: '−1 h', ms: -3_600_000 },
  { label: '+1 min', ms: 60_000 },
  { label: '+1 h', ms: 3_600_000 },
  { label: '+1 day', ms: 86_400_000 },
]

export function ClockPanel({ now, behind, jumpValue, onJumpValue, onShift, onJump }: ClockPanelProps) {
  return (
    <Section title="Clock">
      <output aria-label="Player time" className="font-mono text-sm">
        {now ?? '–'}
        {behind ? <span className="ml-2 text-destructive">set back</span> : null}
      </output>
      <div className="flex flex-wrap gap-1">
        {SHIFTS.map((s) => (
          <Button key={s.label} size="sm" variant="outline" disabled={now === null} onClick={() => onShift(s.ms)}>
            {s.label}
          </Button>
        ))}
      </div>
      <div className="flex gap-1">
        <Input aria-label="Jump to" type="datetime-local" value={jumpValue} onChange={(e) => onJumpValue(e.target.value)} />
        <Button size="sm" variant="outline" disabled={now === null || jumpValue === ''} onClick={onJump}>
          Jump
        </Button>
      </div>
    </Section>
  )
}

const FAULTS: readonly { key: keyof PlayerFaults; label: string; on: string; off: string }[] = [
  { key: 'transport', label: 'Transport gone', on: 'down', off: 'up' },
  { key: 'vault', label: 'Vault write fails', on: 'fails', off: 'ok' },
  { key: 'biometric', label: 'Biometrics unavailable', on: 'unavailable', off: 'ok' },
  { key: 'hostClose', label: 'Host close fails', on: 'fails', off: 'ok' },
]

export function FaultPanel({ faults, onChange }: { faults: PlayerFaults; onChange: (f: Partial<PlayerFaults>) => void }) {
  return (
    <Section title="Faults">
      {FAULTS.map((f) => (
        <label key={f.key} className="flex items-center justify-between gap-2 text-sm">
          <span>{f.label}</span>
          <Switch checked={faults[f.key] === f.on} onCheckedChange={(on) => onChange({ [f.key]: on ? f.on : f.off } as Partial<PlayerFaults>)} />
        </label>
      ))}
    </Section>
  )
}

export interface TimelineRow {
  readonly at: string
  readonly text: string
}

export interface TimelinePanelProps {
  readonly steps: readonly TimelineRow[]
  readonly cursor: number
  readonly playing: boolean
  /** every shown phone attached; before that the steps cannot run */
  readonly ready: boolean
  readonly onPlay: () => void
  readonly onPause: () => void
  readonly onStep: () => void
  readonly onReset: () => void
}

export function TimelinePanel({ steps, cursor, playing, ready, onPlay, onPause, onStep, onReset }: TimelinePanelProps) {
  const done = cursor >= steps.length
  return (
    <Section title="Timeline">
      <div className="flex gap-1">
        {playing ? (
          <Button size="sm" onClick={onPause}>
            Pause
          </Button>
        ) : (
          <Button size="sm" disabled={done || !ready} onClick={onPlay}>
            Play
          </Button>
        )}
        <Button size="sm" variant="outline" disabled={done || playing || !ready} onClick={onStep}>
          Step
        </Button>
        <Button size="sm" variant="ghost" onClick={onReset}>
          Reset
        </Button>
      </div>
      {!ready ? <p className="text-xs text-muted-foreground">Waiting for the phones to start…</p> : null}
      {steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">This scenario has no timeline.</p>
      ) : (
        <ol aria-label="Steps" className="flex flex-col gap-1 text-sm">
          {steps.map((s, i) => {
            const status = i < cursor ? 'done' : i === cursor ? 'next' : 'pending'
            return (
              <li
                key={i}
                data-status={status}
                aria-current={status === 'next' ? 'step' : undefined}
                className={cn(
                  'flex gap-2 rounded-md px-2 py-1',
                  status === 'done' && 'text-muted-foreground line-through decoration-muted-foreground/40',
                  status === 'next' && 'bg-muted font-medium',
                )}
              >
                <span className="w-10 shrink-0 font-mono text-xs leading-5 text-muted-foreground">{s.at}</span>
                <span>{s.text}</span>
              </li>
            )
          })}
        </ol>
      )}
    </Section>
  )
}

export interface ViewPanelProps {
  readonly phoneCount: number
  readonly maxPhones: number
  readonly lang: PlayerLang
  readonly theme: PlayerTheme
  readonly catalog: string
  readonly catalogOptions: readonly Option[]
  readonly onPhoneCount: (n: number) => void
  readonly onLang: (l: PlayerLang) => void
  readonly onTheme: (t: PlayerTheme) => void
  readonly onCatalog: (id: string) => void
}

export function ViewPanel(p: ViewPanelProps) {
  const counts = Array.from({ length: p.maxPhones }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))
  return (
    <Section title="View">
      <Segmented label="Phones" value={String(p.phoneCount)} options={counts} onChange={(v) => p.onPhoneCount(Number(v))} />
      <Segmented<PlayerLang>
        label="Language"
        value={p.lang}
        options={[
          { value: 'en', label: 'EN' },
          { value: 'de', label: 'DE' },
        ]}
        onChange={p.onLang}
      />
      <Segmented<PlayerTheme>
        label="Theme"
        value={p.theme}
        options={[
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
          { value: 'system', label: 'System' },
        ]}
        onChange={p.onTheme}
      />
      <SelectField label="Screen catalog (phone 1)" value={p.catalog} options={p.catalogOptions} onChange={p.onCatalog} />
    </Section>
  )
}

export function PhoneFrame({ label, src, index }: { label: string; src: string; index: number }) {
  return (
    <figure className="flex shrink-0 flex-col gap-2">
      <figcaption className="text-sm font-medium">
        {index + 1} · {label}
      </figcaption>
      <iframe
        title={`Phone ${index + 1}: ${label}`}
        src={src}
        width={390}
        height={844}
        className="rounded-[28px] border-[6px] border-foreground/80 bg-background shadow-lg"
      />
    </figure>
  )
}

export function Inspector({ phones, transport, log }: { phones: readonly Readonly<Record<string, unknown>>[]; transport: string; log: readonly string[] }) {
  return (
    <aside aria-label="Inspector" className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-border bg-sidebar">
      <Section title="Transport">
        <p className="font-mono text-xs" aria-label="Transport state">
          {transport}
        </p>
      </Section>
      <Section title="Phones">
        {phones.length === 0 ? <p className="text-sm text-muted-foreground">No phone attached yet.</p> : null}
        {phones.map((p, i) => (
          <pre key={i} className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-4">
            {JSON.stringify(p, null, 2)}
          </pre>
        ))}
      </Section>
      <Section title="Log" className="border-b-0">
        <ol aria-label="Player log" className="flex flex-col gap-0.5 font-mono text-[11px]">
          {log.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ol>
      </Section>
    </aside>
  )
}
