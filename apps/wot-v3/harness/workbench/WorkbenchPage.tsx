// The workbench page (architecture §7.4): the graph as the stage, the phones as floating windows on
// it (each the full app in its own frame, scaled), the cameras over the stage, the wire along the
// bottom. The layout is the Claude Design workbench's (trust-protocol/apps/gesamtsimulator), the world
// is harness/workbench/world.ts, where the phones sit is harness/workbench/berths.ts. Nothing here is
// state of its own but the layout: the graph is derived from the devices' contact lists, the wire from
// the carrier.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force'
import { capNote, closeDevice, collapseDevice, corridor, EMPTY, focusDevice, FULL_W, MAX_CAP, moveDevice, openDevice, screenH, setCap, type Layout, type Stage } from './berths'
import { avatarsSeenBy, useAvatars, type WorkbenchAvatar } from './avatars'
import { startFlight, type Flight } from './flight'
import { sceneFor, type Edge, type Scene } from './graph'
import type { WireEntry, WorkbenchPerson, WorkbenchWorld } from './world'

/** the phone's own viewport: a small phone, so the app draws large on the stage and its code screen
 *  shows the scan button without scrolling */
const PHONE_W = 300
/** the window's inner width over the phone's viewport */
const SCALE = (FULL_W - 10) / PHONE_W

interface Node extends SimulationNodeDatum {
  id: string
  name: string
  me: boolean
}
interface Link extends SimulationLinkDatum<Node> {
  key: string
  cls: string
  arrow?: boolean
  /** false: drawn, but no force (a star line) */
  layout?: boolean
}

const EDGE_LEGEND = [
  { cls: 'wb-edge', text: 'a real meeting happened', color: '#60a5fa' },
  { cls: 'wb-edge trust2', text: 'identity disclosed, both ways', color: 'oklch(70% 0.15 145)' },
  { cls: 'wb-edge trust1', text: 'one way, introduced, or waiting', color: '#fbbf24' },
  { cls: 'wb-edge star', text: 'known through a contact’s star', color: '#c4b5fd' },
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
  // what the camera knows only through a contact's star: drawn, never pulling the layout
  for (const e of scene.stars) out.push({ key: 's:' + e.key, source: e.a, target: e.b, cls: 'wb-edge star', layout: false })
  return out
}

/** node radii on the stage: large enough to read from the back of a room */
const NODE_R = 17
const NODE_R_ME = 21

/** a node as the person's avatar in the app: their picture, else their initials on their palette colour */
function avatarNode(n: Node, a: WorkbenchAvatar | undefined) {
  const r = n.me ? NODE_R_ME : NODE_R
  // no avatar: the camera's device holds no name for this phone, so none is drawn (#517)
  const av = a ?? { name: '?', image: null, initials: '?', bg: '#94a3b8', fg: '#1e293b', solid: '#94a3b8' }
  return (
    <>
      {/* the app paints its avatars on white: the same ground under the node */}
      <circle r={r} fill="#fff" stroke={av.solid} strokeWidth={2} />
      <circle r={r} fill={av.bg} />
      {av.image ? (
        <>
          <clipPath id={`wb-clip-${n.id}`}>
            <circle r={r} />
          </clipPath>
          <image href={av.image} x={-r} y={-r} width={r * 2} height={r * 2} clipPath={`url(#wb-clip-${n.id})`} preserveAspectRatio="xMidYMid slice" />
        </>
      ) : (
        <text className="initials" dy="0.35em" textAnchor="middle" style={{ fill: av.fg }}>
          {av.initials}
        </text>
      )}
      <text y={r + 19} textAnchor="middle">
        {av.name.split(' ')[0]}
        {n.me ? ' (me)' : ''}
      </text>
    </>
  )
}

function Graph({ scene, stage, centre, open, avatars, onOpen }: { scene: Scene; stage: Stage; centre: number; open: readonly string[]; avatars: ReadonlyMap<string, WorkbenchAvatar>; onOpen: (id: string) => void }) {
  /** the simulation's nodes, by id: they keep their place across scenes (read and written in the effect only) */
  const nodesRef = useRef<Map<string, Node>>(new Map())
  /** what the render draws: a copy of the positions after each tick */
  const [placed, setPlaced] = useState<readonly Node[]>([])

  useEffect(() => {
    const cx = centre, cy = stage.h / 2
    const nodes = scene.nodes.map((n) => {
      const prev = nodesRef.current.get(n.id)
      // a new node starts on a circle by its place in the scene: the same layout every time
      const i = scene.nodes.indexOf(n)
      const a = (i / Math.max(1, scene.nodes.length)) * Math.PI * 2
      const node: Node = prev ?? { id: n.id, name: n.name, me: n.me, x: cx + Math.cos(a) * 80, y: cy + Math.sin(a) * 80 }
      node.me = n.me
      nodesRef.current.set(n.id, node)
      return node
    })
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const links = linksOf(scene).filter((l) => l.layout !== false && byId.has(l.source as string) && byId.has(l.target as string))
    const sim = forceSimulation<Node>(nodes)
      .force('link', forceLink<Node, Link>(links).id((d) => d.id).distance(150).strength(0.6))
      .force('charge', forceManyBody().strength(-420))
      // a pull to the corridor's centre (as the legacy graph had), not only a shift of the centroid:
      // every node stays near the middle, and the tick keeps it on the stage, clear of the wire below
      .force('x', forceX(cx).strength(0.05))
      .force('y', forceY(cy).strength(0.07))
      .force('collide', forceCollide(46))
      .alpha(0.9)
      .on('tick', () => {
        for (const n of nodes) {
          n.x = Math.max(44, Math.min(stage.w - 44, n.x ?? cx))
          n.y = Math.max(44, Math.min(stage.h - 52, n.y ?? cy))
        }
        setPlaced(nodes.map((n) => ({ ...n })))
      })
    return () => void sim.stop()
  }, [scene, centre, stage.w, stage.h])

  const nodes = placed
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const links = linksOf(scene)
  const at = (ref: string | number | Node) => (typeof ref === 'object' ? ref : byId.get(String(ref)))
  return (
    <svg role="group" aria-label="the trust graph">
      <defs>
        <marker id="wb-arrow" viewBox="0 0 10 10" refX="24" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
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
          {avatarNode(n, avatars.get(n.id))}
        </g>
      ))}
    </svg>
  )
}

function Window({ person, avatar, pos, screen, src, focused, online, flying, winRef, onFocus, onMove, onCollapse, onClose, onOnline }: {
  person: WorkbenchPerson
  avatar: WorkbenchAvatar | undefined
  pos: { x: number; y: number }
  screen: number
  src: string
  focused: boolean
  online: boolean
  /** in the ceremony's flight: the scanner on top, the shown code beneath it */
  flying: 'scan' | 'show' | null
  winRef: (el: HTMLDivElement | null) => void
  onFocus: () => void
  onMove: (to: { x: number; y: number }) => void
  onCollapse: () => void
  onClose: () => void
  onOnline: (on: boolean) => void
}) {
  const drag = useRef<{ dx: number; dy: number } | null>(null)
  /** the app has loaded in its frame: until then the screen is dark and shows that it is coming */
  const [loaded, setLoaded] = useState(false)
  return (
    <div ref={winRef} className={'wb-win' + (focused ? ' focus' : '') + (flying ? ` flying-${flying}` : '')} style={{ left: pos.x, top: pos.y, ['--wb-person' as string]: avatar?.solid }} onPointerDown={onFocus} data-window={person.id}>
      <div
        className="wb-win-head"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return
          drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }
          ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (!drag.current) return
          onMove({ x: Math.round(e.clientX - drag.current.dx), y: Math.round(e.clientY - drag.current.dy) })
        }}
        onPointerUp={() => (drag.current = null)}
      >
        <i style={{ background: avatar?.solid }} />
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
      <div className={'wb-win-screen' + (loaded ? '' : ' loading')} style={{ height: screen }} data-loaded={loaded}>
        <iframe title={person.name} name={person.id} src={src} onLoad={() => setLoaded(true)} style={{ width: PHONE_W, height: Math.round(screen / SCALE), transform: `scale(${SCALE})` }} />
      </div>
    </div>
  )
}

const WIRE_MIN = 72
const WIRE_DEFAULT = 150

/** the handle above the wire: drag to make the wire taller or shorter (as the Claude Design workbench) */
function WireHandle({ height, onHeight }: { height: number; onHeight: (h: number) => void }) {
  return (
    <div
      className="wb-wire-handle"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the wire"
      aria-valuenow={height}
      tabIndex={0}
      title="drag to resize"
      onPointerDown={(e) => {
        e.preventDefault()
        const y0 = e.clientY
        const h0 = height
        const move = (ev: PointerEvent) => onHeight(h0 + (y0 - ev.clientY))
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') onHeight(height + 24)
        if (e.key === 'ArrowDown') onHeight(height - 24)
      }}
    >
      <span />
    </div>
  )
}

function Wire({ world, entries, height }: { world: WorkbenchWorld; entries: readonly WireEntry[]; height: number }) {
  const fmt = useMemo(() => new Intl.DateTimeFormat('en-GB', { timeZone: world.clock.timeZone(), hour: '2-digit', minute: '2-digit', second: '2-digit' }), [world])
  const nameOf = (id: string | null) => (id ? (world.people.find((p) => p.id === id)?.name.split(' ')[0] ?? id) : '—')
  const cls = (d: WireEntry['disposition']) => (d === 'taken' ? 'wb-disp-taken' : d === 'in flight' ? 'wb-disp-flight' : 'wb-disp-later')
  return (
    <section className="wb-wire" aria-label="On the wire" style={{ height }}>
      <div className="wb-wire-head">
        <span className="wb-label">On the wire · deliveries</span>
        <span className="sub">
          {`${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} · newest first · as the phones saw it`}
        </span>
      </div>
      <div className="wb-wire-list">
        {entries.length === 0 ? (
          <div className="wb-empty">— nothing on the wire yet · verify someone from a phone —</div>
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

/** the stage's size, measured; the phones' berths and the graph's corridor follow it */
function useStageSize(ref: React.RefObject<HTMLDivElement | null>): Stage {
  const [size, setSize] = useState<Stage>({ w: 1200, h: 620 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return size
}

export function WorkbenchPage({ world, query }: { world: WorkbenchWorld; query: string }) {
  const online = useSyncExternalStore(world.online.subscribe, world.online.get)
  const graph = useSyncExternalStore(world.graph.subscribe, world.graph.get)
  const avatars = useAvatars(world)
  const seen = useSyncExternalStore(world.seen.subscribe, world.seen.get)
  const wire = useSyncExternalStore(world.wire.subscribe, world.wire.get)
  const ceremony = useSyncExternalStore(world.ceremony.subscribe, world.ceremony.get)
  const stageRef = useRef<HTMLDivElement>(null)
  /** the windows on the stage, by phone (the flight animates them) */
  const winEls = useRef(new Map<string, HTMLDivElement>())
  // the ceremony's flight: starts when a phone opens its camera, ends when its scan ended
  const scanning = ceremony.scanning, showing = ceremony.showing
  useEffect(() => {
    if (!scanning) return
    const stage = stageRef.current
    const scanWin = winEls.current.get(scanning)
    const scanFrame = scanWin?.querySelector('iframe')
    if (!stage || !scanWin || !scanFrame) return
    const showWin = showing ? (winEls.current.get(showing) ?? null) : null
    const showFrame = showWin?.querySelector('iframe') ?? null
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const flight: Flight = startFlight({ scanWin, scanFrame, showWin, showFrame, stage, scale: SCALE, reducedMotion, onLanded: () => world.ceremony.land() })
    return () => flight.release()
  }, [scanning, showing, world])
  const stage = useStageSize(stageRef)
  const [camera, setCamera] = useState('god')
  // the graph draws what the camera's device holds (#517); the phone frames are the phones themselves
  const cameraAvatars = useMemo(() => avatarsSeenBy(camera, avatars, seen), [camera, avatars, seen])
  // until the first action the layout is the seating of the first two people on the stage as
  // measured now (derived, so a late measurement seats them right); every action starts from it
  const [touched, setTouched] = useState<Layout | null>(null)
  const layout = useMemo(() => touched ?? world.people.slice(0, 2).reduce((acc, p) => openDevice(acc, p.id, stage), EMPTY), [touched, world.people, stage])
  const setLayout = (f: (s: Layout) => Layout) => setTouched(f(layout))
  const [gearOpen, setGearOpen] = useState(false)
  const [wireH, setWireH] = useState(WIRE_DEFAULT)
  const now = useSyncExternalStore(world.now.subscribe, world.now.get)
  const advance = (ms: number) => world.advance(ms)
  const jumpOff = 'Over a live mediator the clock follows the wall clock: the mediator issues its tokens on real time'
  const fmt = useMemo(() => new Intl.DateTimeFormat('en-GB', { timeZone: world.clock.timeZone(), dateStyle: 'medium', timeStyle: 'short' }), [world])
  const scene = useMemo(() => sceneFor(camera, world.people, graph.edges as readonly Edge[], graph.stars), [camera, world.people, graph])
  const visible = layout.open.filter((id) => !layout.collapsed[id])
  const centre = corridor(stage, visible.length).cx
  const screen = screenH(stage)
  const src = (id: string) => {
    const q = new URLSearchParams(query)
    q.set('phone', id)
    return `?${q.toString()}`
  }
  const show = (id: string) => setLayout((s) => openDevice(s, id, stage))
  const docked = layout.open.filter((id) => layout.collapsed[id])
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
          <button type="button" onClick={() => advance(60_000)} disabled={!world.canJump} title={world.canJump ? undefined : jumpOff}>
            +1 min
          </button>
          <button type="button" onClick={() => advance(3_600_000)} disabled={!world.canJump} title={world.canJump ? undefined : jumpOff}>
            +1 h
          </button>
          <button type="button" onClick={() => advance(86_400_000)} disabled={!world.canJump} title={world.canJump ? undefined : jumpOff}>
            +1 day
          </button>
        </div>
        <span className="wb-spacer" />
        <button type="button" onClick={() => window.location.reload()} title="back to the starting world">
          Reset
        </button>
        <div className="wb-gear">
          <button type="button" aria-pressed={gearOpen} aria-label="settings" title="settings" onClick={() => setGearOpen((o) => !o)}>
            ⚙
          </button>
          {gearOpen && (
            <div className="wb-gear-menu" role="group" aria-label="Devices open at once">
              <span className="wb-label">Devices open at once</span>
              <div className="wb-gear-chips">
                {Array.from({ length: MAX_CAP }, (_, i) => i + 1).map((n) => (
                  <button key={n} type="button" aria-pressed={layout.cap === n} onClick={() => setLayout((s) => setCap(s, n, stage))}>
                    {n}
                  </button>
                ))}
              </div>
              <span className="wb-note">{capNote(layout.cap)}</span>
            </div>
          )}
        </div>
      </header>
      <div className="wb-stage" ref={stageRef} {...(scanning ? { 'data-ceremony': `${scanning}>${showing ?? ''}` } : {})}>
        <Graph scene={scene} avatars={cameraAvatars} stage={stage} centre={centre} open={visible} onOpen={show} />
        <div className="wb-cams">
          <span className="wb-label">Camera</span>
          <div role="group" aria-label="Camera">
            <button type="button" className="wb-chip" aria-pressed={camera === 'god'} onClick={() => setCamera('god')}>
              God's eye
            </button>
            {world.people.map((p) => (
              <button key={p.id} type="button" className="wb-chip" aria-pressed={camera === p.id} onClick={() => setCamera(p.id)}>
                <i style={{ background: avatars.get(p.id)?.solid }} />
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
                <button key={id} type="button" onClick={() => setLayout((s) => collapseDevice(s, id, false))}>
                  <i style={{ background: avatars.get(p.id)?.solid }} />
                  {p.name.split(' ')[0]}
                </button>
              ) : null
            })}
          </div>
        )}
        {visible.map((id) => {
          const p = world.people.find((x) => x.id === id)
          const pos = layout.pos[id]
          if (!p || !pos) return null
          return (
            <Window
              key={id}
              person={p}
              avatar={avatars.get(p.id)}
              pos={pos}
              screen={screen}
              src={src(id)}
              focused={layout.focus === id}
              online={online[id] ?? true}
              flying={scanning === id ? 'scan' : showing === id && scanning ? 'show' : null}
              winRef={(el) => (el ? winEls.current.set(id, el) : winEls.current.delete(id))}
              onFocus={() => setLayout((s) => focusDevice(s, id))}
              onMove={(to) => setLayout((s) => moveDevice(s, id, to))}
              onCollapse={() => setLayout((s) => collapseDevice(s, id, true))}
              onClose={() => setLayout((s) => closeDevice(s, id))}
              onOnline={(on) => world.online.set({ ...online, [id]: on })}
            />
          )
        })}
      </div>
      <WireHandle height={wireH} onHeight={(h) => setWireH(Math.max(WIRE_MIN, Math.min(Math.round(window.innerHeight * 0.7), h)))} />
      <Wire world={world} entries={wire} height={wireH} />
    </div>
  )
}
