// The scenario player page (architecture §7.3): connects the player model to the pure panels.
// Left: scenario, timeline, clock, faults, view. Middle: one to three phones, each an iframe with
// its own app instance (harness.html?phone=<n>), attached to this page's player. Right: inspector.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { CATALOG } from '../../catalog'
import { MAX_PHONES, type Player } from '../player'
import { describeStep } from '../timeline'
import { ClockPanel, FaultPanel, Inspector, PhoneFrame, Section, SelectField, TimelinePanel, ViewPanel, type Option } from './panels'

const LIVE = ''

/** Offset suffix of the scenario's ISO start (e.g. -07:00), for the jump input in local scenario time. */
function offsetOf(iso: string): string {
  return /([+-]\d\d:\d\d|Z)$/.exec(iso)?.[1] ?? 'Z'
}

export function phoneSrc(p: { index: number; scenario: string; lang: string; theme: string; catalog: string | null }): string {
  const q = new URLSearchParams({ phone: String(p.index), scenario: p.scenario, lang: p.lang, theme: p.theme })
  if (p.catalog) q.set('catalog', p.catalog)
  return `harness.html?${q.toString()}`
}

/** An iframe whose URL is fixed at mount: language and theme then change live, without a reload. */
function Phone({ index, label, initialSrc }: { index: number; label: string; initialSrc: string }) {
  const [src] = useState(initialSrc)
  return <PhoneFrame index={index} label={label} src={src} />
}

export function PlayerApp({ player, scenarioOptions }: { player: Player; scenarioOptions: readonly Option[] }) {
  const state = useSyncExternalStore(player.subscribe, player.get)
  const scenario = player.scenario()
  const [jump, setJump] = useState('')
  const [inspection, setInspection] = useState<readonly Readonly<Record<string, unknown>>[]>([])

  useEffect(() => {
    const read = () => setInspection(player.inspect())
    read()
    const t = setInterval(read, 400)
    return () => clearInterval(t)
  }, [player])

  const fmt = useMemo(
    () => new Intl.DateTimeFormat('en-GB', { timeZone: scenario.clock.timeZone, dateStyle: 'medium', timeStyle: 'medium' }),
    [scenario.clock.timeZone],
  )
  const steps = player.timeline().map((s) => ({ at: s.at, text: describeStep(s) }))
  const specs = player.phones()
  const catalogOptions: Option[] = [{ value: LIVE, label: 'Live (scenario)' }, ...CATALOG.map((e) => ({ value: e.id, label: e.id }))]
  const t = state.transport

  return (
    <div className="flex h-dvh bg-background text-foreground">
      <nav aria-label="Player controls" className="flex w-80 shrink-0 flex-col overflow-y-auto border-r border-border bg-sidebar">
        <header className="px-4 py-3">
          <h1 className="text-base font-semibold">Scenario player</h1>
          <p className="text-xs text-muted-foreground">{scenario.title}</p>
        </header>
        <Section title="Scenario">
          <SelectField label="Scenario" value={state.scenarioId} options={scenarioOptions} onChange={player.select} />
        </Section>
        <TimelinePanel steps={steps} cursor={state.cursor} playing={state.playing} onPlay={player.play} onPause={player.pause} onStep={player.step} onReset={player.reset} />
        <ClockPanel
          now={state.now === null ? null : fmt.format(state.now)}
          behind={state.now !== null && state.highWater !== null && state.now < state.highWater}
          jumpValue={jump}
          onJumpValue={setJump}
          onShift={(ms) => (ms < 0 ? player.rewindClock(-ms) : player.advanceClock(ms))}
          onJump={() => {
            const at = Date.parse(`${jump}:00${offsetOf(scenario.clock.start)}`)
            if (!Number.isNaN(at)) player.jumpTo(at)
          }}
        />
        <FaultPanel faults={state.faults} onChange={player.setFault} />
        <ViewPanel
          phoneCount={state.phoneCount}
          maxPhones={MAX_PHONES}
          lang={state.lang}
          theme={state.theme}
          catalog={state.catalog ?? LIVE}
          catalogOptions={catalogOptions}
          onPhoneCount={player.setPhoneCount}
          onLang={player.setLang}
          onTheme={player.setTheme}
          onCatalog={(id) => player.setCatalog(id === LIVE ? null : id)}
        />
      </nav>
      <main className="flex min-w-0 flex-1 gap-6 overflow-auto p-6">
        {specs.map((s, i) => (
          <Phone
            key={`${state.epoch}-${i}-${s.scenario}`}
            index={i}
            label={s.label}
            initialSrc={phoneSrc({ index: i, scenario: s.scenario, lang: state.lang, theme: state.theme, catalog: i === 0 ? state.catalog : null })}
          />
        ))}
      </main>
      <Inspector phones={inspection} transport={`${t.state} · queued ${t.queued} · delivered ${t.delivered}`} log={state.log} />
    </div>
  )
}
