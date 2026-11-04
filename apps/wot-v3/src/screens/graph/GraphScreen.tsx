// The graph tab (Anton 04.11.: "Graph" replaces the groups tab, which v3 does not have yet): the network
// as this device knows it, in the picture language of the legacy app's Network page. You in gold in the
// middle; your contacts with picture or initials, sized by the relationship; edges grey at rest. A tap
// opens a contact into a card in place and colours its edge to you (mutual green, outgoing amber,
// incoming blue, with an arrow), its neighbours' edges half, the rest faint. Dotted violet between two
// contacts: one of them says by its star that they know each other (Trust §5). Nodes can be dragged; a
// button shows the graph on the whole screen. Nobody appears whom the device does not hold.
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force'
import type { ContactId } from '../../port'
import { useNav } from '../../hooks'
import { useGraphInput } from '../../hooks/graph'
import { useI18n } from '../../i18n'
import { ListHeader, PersonAvatar, PrimaryAction } from '../../ui/components'
import { graphModel, type GraphNode, type MyEdge } from '../../hooks/graph-model'

interface SimNode extends SimulationNodeDatum, GraphNode {}

const EDGE_COLOR: Record<'mutual' | 'outgoing' | 'incoming', string> = { mutual: 'var(--success, #059669)', outgoing: '#f59e0b', incoming: '#3b82f6' }
const STAR = '#8b7ad8'
const CARD_W = 196

/** the direction of my edge to a contact, as the legacy graph drew it */
function directionOf(e: MyEdge): 'mutual' | 'outgoing' | 'incoming' {
  if (e.verification === 'outgoing') return 'outgoing'
  if (e.verification === 'incoming') return 'incoming'
  return 'mutual'
}

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
  const sim = useRef<Simulation<SimNode, SimulationLinkDatum<SimNode>> | null>(null)
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
    const nodes: SimNode[] = model.nodes.map((n, i) => {
      const prev = nodesRef.current.get(n.id)
      const a = (i / Math.max(1, model.nodes.length - 1)) * Math.PI * 2
      const node: SimNode = prev ? Object.assign(prev, n) : { ...n, x: n.me ? cx : cx + Math.cos(a) * 110, y: n.me ? cy : cy + Math.sin(a) * 110 }
      if (n.me) {
        node.fx = cx
        node.fy = cy
      }
      return node
    })
    nodesRef.current = new Map(nodes.map((n) => [n.id, n]))
    const links: SimulationLinkDatum<SimNode>[] = [
      ...model.mine.map((e) => ({ source: 'me', target: e.contact })),
      ...model.stars.map((e) => ({ source: e.a, target: e.b })),
    ]
    const s = forceSimulation<SimNode>(nodes)
      .force('link', forceLink<SimNode, SimulationLinkDatum<SimNode>>(links).id((d) => d.id).distance(120).strength(0.4))
      .force('charge', forceManyBody().strength(-420).distanceMin(60))
      .force('collide', forceCollide<SimNode>().radius((d) => d.size + 26))
      .force('x', forceX(cx).strength(0.04))
      .force('y', forceY(cy).strength(0.04))
      .on('tick', () => {
        const m = new Map<string, { x: number; y: number }>()
        for (const n of nodes) {
          const r = n.size + 4
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
  const nameOf = (id: string) => (id === 'me' ? (input?.me.name ?? t.contacts.unnamed) : (contacts.get(id)?.name ?? t.contacts.unnamed))
  const at = (id: string) => placed.get(id)
  const neighbours = new Set<string>()
  if (selected) {
    neighbours.add('me')
    for (const s of model.stars) {
      if (s.a === selected) neighbours.add(s.b)
      if (s.b === selected) neighbours.add(s.a)
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
  const empty = count === 0
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
          <span className="flex size-16 items-center justify-center rounded-full bg-[oklch(0.72_0.15_75)] font-bold text-white shadow-[0_0_0_6px_color-mix(in_oklab,oklch(0.72_0.15_75)_25%,transparent)]">{g.you}</span>
          <p className="m-0 max-w-[30ch] text-sm text-pretty text-muted-foreground">{g.emptyBody}</p>
          <PrimaryAction label={t.shell.verifyInPerson} onClick={() => send({ type: 'push', route: { kind: 'verify' } })} />
        </div>
      ) : (
        <div ref={box} className="relative min-h-0 flex-1 touch-none select-none overflow-hidden" onClick={() => setSelected(null)} data-graph>
          <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
            <defs>
              {(['outgoing', 'incoming'] as const).map((k) => (
                <marker key={k} id={`g-arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M0,0 L10,5 L0,10 z" fill={EDGE_COLOR[k]} />
                </marker>
              ))}
            </defs>
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
              const dir = directionOf(e)
              const touched = selected === e.contact
              const cluster = selected !== null && !touched && neighbours.has(e.contact)
              const node = sizes.get(e.contact)
              const ux = b.x - a.x, uy = b.y - a.y, len = Math.hypot(ux, uy) || 1
              const r1 = 30, r2 = (node ?? 16) + 3
              const [x1, y1, x2, y2] = [a.x + (ux / len) * r1, a.y + (uy / len) * r1, b.x - (ux / len) * r2, b.y - (uy / len) * r2]
              const [lx1, ly1, lx2, ly2] = dir === 'incoming' ? [x2, y2, x1, y1] : [x1, y1, x2, y2]
              return (
                <line
                  key={e.contact}
                  data-edge={`me:${e.contact}`}
                  x1={lx1}
                  y1={ly1}
                  x2={lx2}
                  y2={ly2}
                  stroke={touched || cluster ? EDGE_COLOR[dir] : 'currentColor'}
                  strokeOpacity={selected === null ? 0.25 : touched ? 0.7 : cluster ? 0.35 : 0.12}
                  strokeWidth={touched ? 2.2 : e.trust === 'both' ? 1.8 : 1.2}
                  strokeLinecap="round"
                  {...(dir !== 'mutual' && (touched || cluster) ? { markerEnd: `url(#g-arrow-${dir})` } : {})}
                />
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
                {n.me ? (
                  <span className="flex items-center justify-center rounded-full bg-[oklch(0.72_0.15_75)] text-sm font-bold text-white" style={{ width: n.size * 2, height: n.size * 2 }}>
                    {g.you}
                  </span>
                ) : (
                  <span className="block overflow-hidden rounded-full" style={{ width: n.size * 2, height: n.size * 2, fontSize: Math.max(9, Math.round(n.size * 0.7)) }}>
                    <PersonAvatar name={nameOf(n.id)} image={n.image} size={44} className="!size-full !text-[1em]" />
                  </span>
                )}
                {n.me ? null : <span className="max-w-24 truncate text-[11px] text-foreground">{nameOf(n.id).split(' ')[0]}</span>}
              </button>
            )
          })}
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
