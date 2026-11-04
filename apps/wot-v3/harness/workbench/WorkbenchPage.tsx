// The workbench page (architecture §7.4): the graph as the stage, the phones as floating windows on
// it (each the full app in its own frame, scaled), the cameras over the stage, the wire along the
// bottom. The layout is the Claude Design workbench's (trust-protocol/apps/gesamtsimulator), the world
// is harness/workbench/world.ts. Nothing here is state of its own: the graph is derived from the
// devices' contact lists, the wire from the carrier, the windows from the page's open set.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force'
import { sceneFor, type Edge, type Scene } from './graph'
import type { WireEntry, WorkbenchPerson, WorkbenchWorld } from './world'

interface Node extends SimulationNodeDatum {
  id: string
  name: string
  color: string
  me: boolean
}
interface Link extends SimulationLinkDatum<Node> {
  key: string
  cls: string
  arrow?: boolean
}

const EDGE_LEGEND = [
  { cls: 'wb-edge', text: 'a real meeting happened', color: '#60a5fa' },
  { cls: 'wb-edge trust2', text: 'identity disclosed, both ways', color: 'oklch(70% 0.15 145)' },
  { cls: 'wb-edge trust1', text: 'one way, introduced, or waiting', color: '#fbbf24' },
]

/** the links a scene draws: the meeting line, and the trust line on top of it */
function linksOf(scene: Scene): Link[] {
  const out: Link[] = []
  for (const e of scene.edges) {
    const oneSided = e.verification !== 'mutual' && e.verification !== 'met'
    if (e.verification === 'introduced') {
      out.push({ key: 'v:' + e.key, source: e.a, target: e.b, cls: 'wb-edge via' })
      continue
    }
    out.push({ key: 'e:' + e.key, source: e.a, target: e.b, cls: oneSided ? 'wb-edge one' : 'wb-edge' })
    if (e.trust.length === 2) out.push({ key: 't:' + e.key, source: e.a, target: e.b, cls: 'wb-edge trust2' })
    else if (e.trust.length === 1) {
      const from = e.trust[0] as string
      out.push({ key: 't:' + e.key, source: from, target: from === e.a ? e.b : e.a, cls: 'wb-edge trust1', arrow: true })
    }
  }
  return out
}

function Graph({ world, scene, open, onOpen }: { world: WorkbenchWorld; scene: Scene; open: readonly string[]; onOpen: (id: string) => void }) {
  const svgRef = useRef<SVGSVGElement>(null)
  /** the simulation's nodes, by id: they keep their place across scenes (read and written in the effect only) */
  const nodesRef = useRef<Map<string, Node>>(new Map())
  /** what the render draws: a copy of the positions after each tick */
  const [placed, setPlaced] = useState<readonly Node[]>([])
  const colorOf = useMemo(() => new Map(world.people.map((p) => [p.id, p.color])), [world.people])

  // the simulation: nodes keep their place across scenes; new ones start near the middle
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const w = svg.clientWidth || 900, h = svg.clientHeight || 500
    // the windows open on the left: the graph gathers in the right two thirds of the stage
    const cx = w * 0.66, cy = h / 2
    const nodes = scene.nodes.map((n) => {
      const prev = nodesRef.current.get(n.id)
      const node: Node = prev ?? { id: n.id, name: n.name, color: colorOf.get(n.id) ?? '#94a3b8', me: n.me, x: cx + (Math.random() - 0.5) * 160, y: cy + (Math.random() - 0.5) * 160 }
      node.me = n.me
      nodesRef.current.set(n.id, node)
      return node
    })
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const links = linksOf(scene).filter((l) => byId.has(l.source as string) && byId.has(l.target as string))
    const sim = forceSimulation<Node>(nodes)
      .force('link', forceLink<Node, Link>(links).id((d) => d.id).distance(150).strength(0.6))
      .force('charge', forceManyBody().strength(-420))
      .force('center', forceCenter(cx, cy).strength(0.08))
      .force('collide', forceCollide(34))
      .alpha(0.9)
      .on('tick', () => setPlaced(nodes.map((n) => ({ ...n }))))
    return () => void sim.stop()
  }, [scene, colorOf])

  const nodes = placed
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const links = linksOf(scene)
  const at = (ref: string | number | Node) => (typeof ref === 'object' ? ref : byId.get(String(ref)))
  return (
    <svg ref={svgRef} role="img" aria-label="the trust graph">
      <defs>
        <marker id="wb-arrow" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#fbbf24" />
        </marker>
      </defs>
      {links.map((l) => {
        const a = at(l.source), b = at(l.target)
        if (!a || !b) return null
        return <line key={l.key} className={l.cls} data-edge={l.key} x1={a.x} y1={a.y} x2={b.x} y2={b.y} {...(l.arrow ? { markerEnd: 'url(#wb-arrow)' } : {})} />
      })}
      {nodes.map((n) => (
        <g key={n.id} className={'wb-node' + (open.includes(n.id) ? ' open' : '')} data-node={n.id} transform={`translate(${n.x ?? 0},${n.y ?? 0})`} onClick={() => onOpen(n.id)} role="button" tabIndex={0} aria-label={`${n.name}: open the phone`} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ' ? onOpen(n.id) : undefined)}>
          <circle r={n.me ? 13 : 10} fill={n.color} stroke={n.color} strokeWidth={1.5} />
          <text y={n.me ? 28 : 24} textAnchor="middle">
            {n.name.split(' ')[0]}
            {n.me ? ' (me)' : ''}
          </text>
        </g>
      ))}
    </svg>
  )
}

function Window({ world, person, index, src, focused, online, onFocus, onCollapse, onClose, onOnline }: {
  world: WorkbenchWorld
  person: WorkbenchPerson
  index: number
  src: string
  focused: boolean
  online: boolean
  onFocus: () => void
  onCollapse: () => void
  onClose: () => void
  onOnline: (on: boolean) => void
}) {
  const [pos, setPos] = useState({ left: 24 + index * 310, top: 112 })
  const drag = useRef<{ dx: number; dy: number } | null>(null)
  void world
  return (
    <div
      className={'wb-win' + (focused ? ' focus' : '')}
      style={{ left: pos.left, top: pos.top }}
      onPointerDown={onFocus}
      data-window={person.id}
    >
      <div
        className="wb-win-head"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return
          drag.current = { dx: e.clientX - pos.left, dy: e.clientY - pos.top }
          ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (!drag.current) return
          setPos({ left: Math.max(0, e.clientX - drag.current.dx), top: Math.max(0, e.clientY - drag.current.dy) })
        }}
        onPointerUp={() => (drag.current = null)}
      >
        <i style={{ background: person.color }} />
        <span className="name">{person.name}</span>
        <button type="button" className={online ? '' : 'off'} aria-pressed={!online} title={online ? 'take the phone offline' : 'bring the phone online'} onClick={() => onOnline(!online)}>
          {online ? 'online' : 'offline'}
        </button>
        <button type="button" title="collapse into the dock" onClick={onCollapse} aria-label={`collapse ${person.name}`}>
          ▾
        </button>
        <button type="button" title="close" onClick={onClose} aria-label={`close ${person.name}`}>
          ✕
        </button>
      </div>
      <div className="wb-win-screen">
        <iframe title={person.name} name={person.id} src={src} />
      </div>
    </div>
  )
}

function Wire({ world, entries }: { world: WorkbenchWorld; entries: readonly WireEntry[] }) {
  const fmt = useMemo(() => new Intl.DateTimeFormat('en-GB', { timeZone: world.clock.timeZone(), hour: '2-digit', minute: '2-digit', second: '2-digit' }), [world])
  const nameOf = (id: string | null) => (id ? (world.people.find((p) => p.id === id)?.name.split(' ')[0] ?? id) : '—')
  const cls = (d: WireEntry['disposition']) => (d === 'taken' ? 'wb-disp-taken' : d === 'in flight' ? 'wb-disp-flight' : d === 'refused for now' ? 'wb-disp-later' : 'wb-disp-nobody')
  return (
    <section className="wb-wire" aria-label="On the wire">
      <div className="wb-wire-head">
        <span className="wb-label">On the wire · deliveries</span>
        <span className="sub">
          {world.wireObservable ? `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} · newest first` : 'not observable over this carrier yet: the phones say what arrived'}
        </span>
      </div>
      <div className="wb-wire-list">
        {entries.length === 0 ? (
          <div className="wb-empty">{world.wireObservable ? '— nothing on the wire yet · verify someone from a phone —' : ''}</div>
        ) : (
          <table>
            <tbody>
              {entries.map((e) => (
                <tr key={e.digest + ':' + e.attempt} data-wire={e.n}>
                  <td className="n">{e.n}</td>
                  <td>{fmt.format(e.at)}</td>
                  <td>
                    {nameOf(e.from)} ⇒ {nameOf(e.to)}
                  </td>
                  <td className={cls(e.disposition)}>{e.disposition}</td>
                  <td className="type">{e.type}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}

export function WorkbenchPage({ world, query }: { world: WorkbenchWorld; query: string }) {
  const online = useSyncExternalStore(world.online.subscribe, world.online.get)
  const graph = useSyncExternalStore(world.graph.subscribe, world.graph.get)
  const wire = useSyncExternalStore(world.wire.subscribe, world.wire.get)
  const [camera, setCamera] = useState('god')
  const [open, setOpen] = useState<readonly string[]>(world.people.slice(0, 2).map((p) => p.id))
  const [docked, setDocked] = useState<readonly string[]>([])
  const [focus, setFocus] = useState<string | null>(null)
  const [now, setNow] = useState(world.clock.now())
  const advance = (ms: number) => {
    world.clock.advance(ms)
    setNow(world.clock.now())
  }
  const fmt = useMemo(() => new Intl.DateTimeFormat('en-GB', { timeZone: world.clock.timeZone(), dateStyle: 'medium', timeStyle: 'short' }), [world])
  const scene = useMemo(() => sceneFor(camera, world.people, graph.edges as readonly Edge[]), [camera, world.people, graph])
  const src = (id: string) => {
    const q = new URLSearchParams(query)
    q.set('phone', id)
    return `?${q.toString()}`
  }
  const show = (id: string) => {
    setDocked((d) => d.filter((x) => x !== id))
    setOpen((o) => (o.includes(id) ? o : [...o, id]))
    setFocus(id)
  }
  const carrierLabel = world.carrier.kind === 'memory' ? 'in memory' : world.carrier.kind === 'mediator' ? 'VTI mediator double' : `live mediator ${world.carrier.did.slice(0, 24)}…`
  return (
    <div className="wb">
      <header className="wb-top">
        <h1>
          Workbench
          <small>graph · phones · wire</small>
        </h1>
        <div className="wb-group">
          <span className="wb-label">Carrier</span>
          <span className="wb-clock">{carrierLabel}</span>
        </div>
        <div className="wb-group">
          <span className="wb-label">Clock</span>
          <span className="wb-clock" data-clock>
            {fmt.format(now)}
          </span>
          <button type="button" onClick={() => advance(60_000)}>
            +1 min
          </button>
          <button type="button" onClick={() => advance(3_600_000)}>
            +1 h
          </button>
          <button type="button" onClick={() => advance(86_400_000)}>
            +1 day
          </button>
        </div>
        <span className="wb-spacer" />
        <button type="button" onClick={() => window.location.reload()} title="back to the starting world">
          Reset
        </button>
      </header>
      <div className="wb-stage">
        <Graph world={world} scene={scene} open={open} onOpen={show} />
        <div className="wb-cams">
          <span className="wb-label">Camera</span>
          <div role="group" aria-label="Camera">
            <button type="button" className="wb-chip" aria-pressed={camera === 'god'} onClick={() => setCamera('god')}>
              God's eye
            </button>
            {world.people.map((p) => (
              <button key={p.id} type="button" className="wb-chip" aria-pressed={camera === p.id} onClick={() => setCamera(p.id)}>
                <i style={{ background: p.color }} />
                {p.name.split(' ')[0]}
              </button>
            ))}
          </div>
          <div className="wb-note" data-note>
            {scene.note}
          </div>
        </div>
        <div className="wb-legend" aria-hidden="true">
          {EDGE_LEGEND.map((l) => (
            <span key={l.cls}>
              <i style={{ background: l.color }} />
              {l.text}
            </span>
          ))}
        </div>
        {docked.length > 0 && (
          <div className="wb-dock">
            <span className="wb-label">Docked</span>
            {docked.map((id) => {
              const p = world.people.find((x) => x.id === id)
              return p ? (
                <button key={id} type="button" onClick={() => show(id)}>
                  <i style={{ background: p.color }} />
                  {p.name.split(' ')[0]}
                </button>
              ) : null
            })}
          </div>
        )}
        {open.map((id, i) => {
          const p = world.people.find((x) => x.id === id)
          if (!p || docked.includes(id)) return null
          return (
            <Window
              key={id}
              world={world}
              person={p}
              index={i}
              src={src(id)}
              focused={focus === id}
              online={online[id] ?? true}
              onFocus={() => setFocus(id)}
              onCollapse={() => setDocked((d) => [...d, id])}
              onClose={() => setOpen((o) => o.filter((x) => x !== id))}
              onOnline={(on) => world.online.set({ ...online, [id]: on })}
            />
          )
        })}
      </div>
      <Wire world={world} entries={wire} />
    </div>
  )
}
