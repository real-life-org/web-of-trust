// The graph tab (Anton 04.11.: "Graph"): the network as this device knows it. You in gold in the middle;
// your contacts with picture or initials, sized by the relationship; a group as a dashed circle on the
// outer ring with its name, the members that are no contact of yours grey dots at it.
//
// The lines (Anton 22.11.), the same as on the workbench, in colour at rest:
//   stroke = how sure: solid stands · dashed is one-sided or open, with an arrow from the one who acted ·
//            dotted is someone else's word
//   colour = what: blue the verification · yellow an introduction · red a contact over a link ·
//            green the trust · grey a group's membership · violet what a contact's star says
// The trust is a narrower green line on its ground, so the ground shows as its rim, and through the gaps
// of a one-sided trust. A tap opens a contact or a group into a card in place and fades what does not
// touch it; nothing changes colour. Nodes can be dragged; a button shows the graph on the whole screen.
// Nobody appears whom the device does not hold.
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { forceCollide, forceLink, forceManyBody, forceRadial, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force'
import type { ContactId } from '../../port'
import { useNav } from '../../hooks'
import { useGraphInput } from '../../hooks/graph'
import { useI18n } from '../../i18n'
import { GroupsIcon, ListHeader, PersonAvatar, PrimaryAction } from '../../ui/components'
import { graphModel, lookOf } from '../../hooks/graph-model'

interface SimNode extends SimulationNodeDatum {
  id: string
  me: boolean
  /** a group's hub, not a person */
  hub: boolean
  size: number
}
interface SimLink extends SimulationLinkDatum<SimNode> {
  /** a membership: long and soft, so the hub rests outside the people it joins */
  member?: boolean
}

/** the dots a hub draws at most; a larger group shows these and says its number in the card */
const MAX_DOTS = 12

const GROUND = { verified: 'var(--primary)', introduced: 'var(--warning)', link: 'var(--destructive)' } as const
const TRUST = 'var(--success)'
const STAR = '#8b7ad8'
const CARD_W = 196
/** the ground line and the trust line on it */
const GROUND_W = 3
/** a one-sided or unproven ground is a lighter line: finer, and dashed */
const GROUND_W_OPEN = 1.8
const TRUST_W = 1.4
/** dashes, not dots: dotted is the star's alone */
const DASH = '5 6'

/** your node: the gold ring around your avatar marks the middle of the graph */
const ME_RING = 'shadow-[0_0_0_3px_oklch(0.72_0.15_75),0_0_0_7px_color-mix(in_oklab,oklch(0.72_0.15_75)_25%,transparent)]'

export function GraphScreen() {
  const { t, f } = useI18n()
  const g = t.graph
  const { send } = useNav()
  const input = useGraphInput()
  const model = useMemo(() => (input ? graphModel(input) : null), [input])
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 360, h: 520 })
  const [placed, setPlaced] = useState<ReadonlyMap<string, { x: number; y: number }>>(new Map())
  const [selected, setSelected] = useState<string | null>(null)
  const [full, setFull] = useState(false)
  const sim = useRef<Simulation<SimNode, SimLink> | null>(null)
  const nodesRef = useRef<Map<string, SimNode>>(new Map())

  useEffect(() => {
    const el = box.current
    if (!el) return
    const read = () => setSize({ w: el.clientWidth || 360, h: el.clientHeight || 520 })
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // the simulation: positions survive changes of the model; "me" is held in the middle
  useEffect(() => {
    if (!model) return
    const cx = size.w / 2, cy = size.h / 2
    // the hubs' ring: outside the people, inside the box
    const ring = Math.max(90, Math.min(size.w, size.h) / 2 - 56)
    const people: SimNode[] = model.nodes.map((n, i) => {
      const prev = nodesRef.current.get(n.id)
      const a = (i / Math.max(1, model.nodes.length - 1)) * Math.PI * 2
      const node: SimNode = prev ? Object.assign(prev, { size: n.size }) : { id: n.id, me: n.me, hub: false, size: n.size, x: n.me ? cx : cx + Math.cos(a) * 110, y: n.me ? cy : cy + Math.sin(a) * 110 }
      if (n.me) {
        node.fx = cx
        node.fy = cy
      }
      return node
    })
    const hubs: SimNode[] = model.hubs.map((h, i) => {
      const prev = nodesRef.current.get(h.id)
      // a new hub starts on the ring, between the top and the sides: the same place every time
      const a = -Math.PI / 4 + (i / Math.max(1, model.hubs.length)) * Math.PI * 2
      return prev ? Object.assign(prev, { size: h.size }) : { id: h.id, me: false, hub: true, size: h.size, x: cx + Math.cos(a) * ring, y: cy + Math.sin(a) * ring }
    })
    const nodes = [...people, ...hubs]
    nodesRef.current = new Map(nodes.map((n) => [n.id, n]))
    const links: SimLink[] = [
      ...model.mine.map((e) => ({ source: 'me', target: e.contact as string })),
      ...model.stars.map((e) => ({ source: e.a as string, target: e.b as string })),
      ...model.memberships.map((e) => ({ source: e.node, target: e.hub, member: true })),
    ]
    const s = forceSimulation<SimNode>(nodes)
      .force('link', forceLink<SimNode, SimLink>(links).id((d) => d.id).distance((l) => (l.member ? ring : 120)).strength((l) => (l.member ? 0.08 : 0.4)))
      .force('charge', forceManyBody().strength(-420).distanceMin(60))
      .force('collide', forceCollide<SimNode>().radius((d) => d.size + (d.hub ? 34 : 26)))
      .force('ring', forceRadial<SimNode>(ring, cx, cy).strength((d) => (d.hub ? 0.5 : 0)))
      .force('x', forceX(cx).strength(0.04))
      .force('y', forceY(cy).strength(0.04))
      .on('tick', () => {
        const m = new Map<string, { x: number; y: number }>()
        for (const n of nodes) {
          // a hub keeps room for its dots and for its name
          const r = n.size + (n.hub ? 22 : 4)
          n.x = Math.max(r, Math.min(size.w - r, n.x ?? cx))
          n.y = Math.max(r, Math.min(size.h - r - 16, n.y ?? cy))
          m.set(n.id, { x: n.x, y: n.y })
        }
        setPlaced(m)
      })
    sim.current = s
    return () => void s.stop()
  }, [model, size.w, size.h])

  if (!model) return <ListHeader title={t.nav.graph} />

  const contacts = new Map((input?.contacts ?? []).map((c) => [c.id as string, c]))
  const sizes = new Map(model.nodes.map((n) => [n.id, n.size]))
  const hubById = new Map(model.hubs.map((h) => [h.id, h]))
  const nameOf = (id: string) => (id === 'me' ? (input?.me.name ?? t.contacts.unnamed) : (contacts.get(id)?.name ?? t.contacts.unnamed))
  const at = (id: string) => placed.get(id)
  const neighbours = new Set<string>()
  if (selected) {
    neighbours.add('me')
    for (const s of model.stars) {
      if (s.a === selected) neighbours.add(s.b)
      if (s.b === selected) neighbours.add(s.a)
    }
    // a group and its members stand together: the hub with everyone it joins, a person with their hubs
    for (const m of model.memberships) {
      if (m.hub === selected) neighbours.add(m.node)
      if (m.node === selected) neighbours.add(m.hub)
    }
  }
  const drag = (id: string) => (e: ReactPointerEvent<HTMLElement>) => {
    const n = nodesRef.current.get(id)
    const el = box.current
    if (!n || n.me || !el) return
    const r = el.getBoundingClientRect()
    let moved = false
    const startX = e.clientX, startY = e.clientY
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return
      moved = true
      n.fx = ev.clientX - r.left
      n.fy = ev.clientY - r.top
      sim.current?.alphaTarget(0.3).restart()
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      n.fx = null
      n.fy = null
      sim.current?.alphaTarget(0)
      if (!moved) setSelected((s) => (s === id ? null : id))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const count = model.nodes.length - 1
  const empty = count === 0 && model.hubs.length === 0
  const selHub = selected ? hubById.get(selected) : undefined
  const selSaid = selHub ? model.memberships.filter((m) => m.hub === selHub.id && m.by === 'said').map((m) => nameOf(m.node)) : []
  const sel = selected ? contacts.get(selected) : undefined
  const selEdge = selected ? model.mine.find((e) => e.contact === selected) : undefined
  const selShared = sel?.shared?.filter((id) => contacts.has(id)).map(nameOf) ?? []

  return (
    <div className={full ? 'fixed inset-0 z-50 flex flex-col bg-background' : 'flex min-h-0 flex-1 flex-col'}>
      <header className="flex flex-none items-start justify-between px-5 pt-[18px] pb-1">
        <div>
          <h1 className="m-0 text-[22px] font-bold tracking-[-0.02em]">{t.nav.graph}</h1>
          <p className="m-0 text-xs text-muted-foreground">{empty ? g.nobody : f(count === 1 ? g.countOne : g.count, { n: String(count) })}</p>
        </div>
        {empty ? null : (
          <button type="button" onClick={() => setFull((v) => !v)} aria-label={full ? g.exitFull : g.full} className="hit-target rounded-md p-1.5 text-muted-foreground hover:text-foreground">
            {full ? '⤡' : '⤢'}
          </button>
        )}
      </header>
      {empty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
          <span className={'block size-16 overflow-hidden rounded-full text-2xl ' + ME_RING}>
            <PersonAvatar name={input?.me.name ?? g.you} image={input?.me.image ?? null} size={44} className="!size-full !text-[1em]" />
          </span>
          <p className="m-0 max-w-[30ch] text-sm text-pretty text-muted-foreground">{g.emptyBody}</p>
          <PrimaryAction label={t.shell.verifyInPerson} onClick={() => send({ type: 'push', route: { kind: 'verify' } })} />
        </div>
      ) : (
        <div ref={box} className="relative min-h-0 flex-1 touch-none select-none overflow-hidden" onClick={() => setSelected(null)} data-graph>
          <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
            <defs>
              {([['verified', GROUND.verified, 9], ['trust', TRUST, 9]] as const).map(([k, fill, w]) => (
                <marker key={k} id={`g-arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth={w} markerHeight={w} orient="auto">
                  <path d="M0,0 L10,5 L0,10 z" fill={fill} />
                </marker>
              ))}
            </defs>
            {model.memberships.map((m) => {
              const a = at(m.node), b = at(m.hub)
              const hub = hubById.get(m.hub)
              if (!a || !b || !hub) return null
              const touched = selected !== null && (m.hub === selected || m.node === selected)
              const ux = b.x - a.x, uy = b.y - a.y, len = Math.hypot(ux, uy) || 1
              const r1 = (m.node === 'me' ? 30 : (sizes.get(m.node) ?? 16) + 3), r2 = hub.size + 2
              return (
                <line
                  key={m.key}
                  data-edge={`member:${m.key}`}
                  x1={a.x + (ux / len) * r1}
                  y1={a.y + (uy / len) * r1}
                  x2={b.x - (ux / len) * r2}
                  y2={b.y - (uy / len) * r2}
                  data-by={m.by}
                  // grey a membership: solid by the log, dashed while you are joining; the contact's word
                  // dotted violet, as every star is
                  stroke={m.by === 'said' ? STAR : 'currentColor'}
                  strokeOpacity={m.by === 'said' ? (selected === null ? 0.7 : touched ? 0.95 : 0.15) : selected === null ? 0.28 : touched ? 0.6 : 0.1}
                  strokeWidth={m.by === 'said' ? 1.5 : 1.2}
                  {...(m.by === 'said' ? { strokeDasharray: '1.5 5' } : m.by === 'joining' ? { strokeDasharray: DASH } : {})}
                  strokeLinecap="round"
                />
              )
            })}
            {model.hubs.map((h) => {
              const p = at(h.id)
              if (!p || h.id === selected) return null
              const n = Math.min(h.unknown, MAX_DOTS)
              const faint = selected !== null && !neighbours.has(h.id)
              // the members nobody here knows: dots around the upper half and the sides, clear of the name
              return Array.from({ length: n }, (_, i) => {
                const a = Math.PI * 0.75 + ((i + 0.5) / n) * Math.PI * 1.5
                return <circle key={`${h.id}:${i}`} data-dot={h.id} cx={p.x + Math.cos(a) * (h.size + 8)} cy={p.y + Math.sin(a) * (h.size + 8)} r={2.6} fill="currentColor" fillOpacity={faint ? 0.12 : 0.38} />
              })
            })}
            {model.stars.map((s) => {
              const a = at(s.a), b = at(s.b)
              if (!a || !b) return null
              const touched = selected !== null && (s.a === selected || s.b === selected)
              const cluster = selected !== null && !touched && neighbours.has(s.a) && neighbours.has(s.b)
              const op = selected === null ? 0.7 : touched ? 0.9 : cluster ? 0.45 : 0.15
              return <line key={s.key} data-edge={`star:${s.key}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={STAR} strokeOpacity={op} strokeWidth={touched ? 2 : 1.5} strokeDasharray="1.5 5" strokeLinecap="round" />
            })}
            {model.mine.map((e) => {
              const a = at('me'), b = at(e.contact)
              if (!a || !b) return null
              const look = lookOf(e)
              const touched = selected === e.contact
              const cluster = selected !== null && !touched && neighbours.has(e.contact)
              const op = selected === null ? 0.7 : touched ? 1 : cluster ? 0.45 : 0.12
              const ux = b.x - a.x, uy = b.y - a.y, len = Math.hypot(ux, uy) || 1
              // clear of your gold ring, so an arrow toward you is seen
              const r1 = 38, r2 = (sizes.get(e.contact) ?? 16) + 3
              const out = { x1: a.x + (ux / len) * r1, y1: a.y + (uy / len) * r1, x2: b.x - (ux / len) * r2, y2: b.y - (uy / len) * r2 }
              // an arrow points away from the one who acted: a line is drawn from them
              const from = (arrow: 'out' | 'in' | null) => (arrow === 'in' ? { x1: out.x2, y1: out.y2, x2: out.x1, y2: out.y1 } : out)
              return (
                <g key={e.contact} opacity={op}>
                  <line
                    data-edge={`me:${e.contact}`}
                    data-ground={look.ground.kind}
                    {...from(look.ground.arrow)}
                    stroke={GROUND[look.ground.kind]}
                    strokeWidth={look.ground.dashed ? GROUND_W_OPEN : GROUND_W}
                    strokeLinecap="round"
                    {...(look.ground.dashed ? { strokeDasharray: DASH } : {})}
                    {...(look.ground.arrow && !look.trust ? { markerEnd: 'url(#g-arrow-verified)' } : {})}
                  />
                  {look.trust ? (
                    <line
                      data-edge={`trust:${e.contact}`}
                      data-trust={e.trust}
                      {...from(look.trust.arrow)}
                      stroke={TRUST}
                      strokeWidth={TRUST_W}
                      strokeLinecap="round"
                      {...(look.trust.dashed ? { strokeDasharray: DASH } : {})}
                      {...(look.trust.arrow ? { markerEnd: 'url(#g-arrow-trust)' } : {})}
                    />
                  ) : null}
                </g>
              )
            })}
          </svg>
          {model.nodes.map((n) => {
            const p = at(n.id)
            if (!p) return null
            if (n.id === selected && sel) return null
            const faint = selected !== null && n.id !== selected && !neighbours.has(n.id)
            return (
              <button
                key={n.id}
                type="button"
                data-node={n.id}
                aria-label={n.me ? g.you : nameOf(n.id)}
                onPointerDown={drag(n.id)}
                onClick={(e) => {
                  e.stopPropagation()
                  // a click without a pointer is the keyboard (Enter, Space): it selects as a tap does
                  if (e.detail === 0 && !n.me) setSelected((s) => (s === n.id ? null : n.id))
                }}
                className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1 transition-opacity"
                style={{ left: p.x, top: p.y, opacity: faint ? 0.4 : 1 }}
              >
                {/* every node is the person's avatar; yours in the middle with the gold ring (Anton 05.11.) */}
                <span
                  className={'block overflow-hidden rounded-full' + (n.me ? ' ' + ME_RING : '')}
                  style={{ width: n.size * 2, height: n.size * 2, fontSize: Math.max(9, Math.round(n.size * 0.7)) }}
                >
                  <PersonAvatar name={n.me ? (input?.me.name ?? g.you) : nameOf(n.id)} image={n.image} size={44} className="!size-full !text-[1em]" />
                </span>
                <span className={'max-w-24 truncate text-[11px] text-foreground' + (n.me ? ' font-semibold' : '')}>{n.me ? g.you : nameOf(n.id).split(' ')[0]}</span>
              </button>
            )
          })}
          {model.hubs.map((h) => {
            const p = at(h.id)
            if (!p || h.id === selected) return null
            const faint = selected !== null && !neighbours.has(h.id)
            return (
              <button
                key={h.id}
                type="button"
                data-hub={h.group}
                aria-label={h.name}
                onPointerDown={drag(h.id)}
                onClick={(e) => {
                  e.stopPropagation()
                  if (e.detail === 0) setSelected((s) => (s === h.id ? null : h.id))
                }}
                className="absolute -translate-x-1/2 -translate-y-1/2 transition-opacity"
                style={{ left: p.x, top: p.y, width: h.size * 2, height: h.size * 2, opacity: faint ? 0.4 : 1 }}
              >
                <span className={'flex size-full items-center justify-center rounded-full border-[1.5px] border-dashed text-muted-foreground ' + (h.joining ? 'border-muted-foreground/40' : 'border-muted-foreground/80')}>
                  <GroupsIcon width={h.size} height={h.size} />
                </span>
                {/* the name hangs under the circle and does not move it off its place */}
                <span className="absolute top-full left-1/2 mt-1 max-w-28 -translate-x-1/2 truncate text-[11px] text-muted-foreground">{h.name}</span>
              </button>
            )
          })}
          {selHub && selected && at(selected) ? (
            <div
              role="dialog"
              aria-label={selHub.name}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => {
                if ((e.target as HTMLElement).closest('button')) return
                drag(selected)(e)
              }}
              className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col gap-2 rounded-2xl border-[1.5px] border-dashed border-muted-foreground/80 bg-card p-3 text-left shadow-lg"
              style={{ left: Math.min(Math.max(at(selected)!.x, CARD_W / 2 + 8), size.w - CARD_W / 2 - 8), top: at(selected)!.y, width: CARD_W }}
            >
              <div className="flex items-center gap-2">
                <PersonAvatar name={selHub.name} shape="square" size={38} />
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{selHub.name}</div>
                  <div className="text-[11px] text-muted-foreground">{selHub.joining ? t.groups.joining : selHub.members <= 1 ? t.groups.oneMember : f(t.groups.members, { n: String(selHub.members) })}</div>
                </div>
              </div>
              {selSaid.length > 0 ? <p className="m-0 text-[11px] text-pretty text-muted-foreground">{f(g.groupSaid, { names: selSaid.join(', ') })}</p> : null}
              {selHub.unknown > 0 ? <p className="m-0 text-[11px] text-pretty text-muted-foreground">{f(selHub.unknown === 1 ? g.groupUnknownOne : g.groupUnknown, { n: String(selHub.unknown) })}</p> : null}
              <button type="button" className="rounded-lg bg-primary px-3 py-1.5 text-[13px] font-semibold text-primary-foreground" onClick={() => send({ type: 'push', route: { kind: 'group', id: selHub.group } })}>
                {g.open}
              </button>
            </div>
          ) : null}
          {sel && selected && at(selected) ? (
            <div
              role="dialog"
              aria-label={nameOf(selected)}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => {
                // the card's own controls are not a drag or a tap on the card (review 510)
                if ((e.target as HTMLElement).closest('button')) return
                drag(selected)(e)
              }}
              className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col gap-2 rounded-2xl bg-card p-3 text-left shadow-lg ring-2 ring-[oklch(0.72_0.15_60)]"
              style={{ left: Math.min(Math.max(at(selected)!.x, CARD_W / 2 + 8), size.w - CARD_W / 2 - 8), top: at(selected)!.y, width: CARD_W }}
            >
              <div className="flex items-center gap-2">
                <PersonAvatar name={nameOf(selected)} image={sel.image} size={38} />
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{nameOf(selected)}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {t.verification[sel.verification]}
                    {selEdge && selEdge.trust !== 'none' ? ` · ${selEdge.trust === 'both' ? t.trust.both : selEdge.trust === 'given' ? t.trust.given : t.trust.received}` : ''}
                  </div>
                </div>
              </div>
              {selShared.length > 0 ? <p className="m-0 text-[11px] text-pretty text-muted-foreground">{f(g.shared, { names: selShared.join(', '), name: nameOf(selected).split(' ')[0] ?? '' })}</p> : null}
              <button
                type="button"
                className="rounded-lg bg-primary px-3 py-1.5 text-[13px] font-semibold text-primary-foreground"
                onClick={() => send({ type: 'push', route: { kind: 'contact', id: selected as ContactId } })}
              >
                {g.open}
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
