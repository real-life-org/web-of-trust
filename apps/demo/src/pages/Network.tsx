import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { forceSimulation, forceLink, forceManyBody, forceCollide, forceX, forceY } from 'd3-force'
import { UserPlus, Award, Users, ArrowLeftRight, ArrowDownLeft, ArrowUpRight, Maximize2, Minimize2 } from 'lucide-react'
import { useNetworkGraph, type GraphNode } from '../hooks/useNetworkGraph'
import { useGraphLivePolling } from '../hooks/useGraphLivePolling'
import { useLanguage } from '../i18n'
import { Avatar } from '../components/shared'
import { getInitials, getColorIndex, colors, PLACEHOLDER_ACCENTS } from '../components/shared/Avatar'
import { layoutSignature, mergeSimNodes, rescaleSimNodes, type SimNode } from './network-layout'

function nodeColor(hue: number): string {
  return `oklch(0.65 0.18 ${hue})`
}
function nodeColorAlpha(hue: number, alpha: number): string {
  return `oklch(0.65 0.18 ${hue} / ${alpha})`
}
/**
 * rgb/hex-Basisfarbe → rgba mit Alpha. Placeholder-Nodes (kein Avatar) treiben
 * Ring + Glow aus ihrer deterministischen Kontaktlisten-Farbe (PLACEHOLDER_ACCENTS,
 * hex); diese Helferfunktion macht daraus die alpha-versehenen border/boxShadow-
 * Werte — analog zu nodeColorAlpha fürs Hue-System.
 */
function hexAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
function statusLabel(type: string, t: any): string {
  if (type === 'mutual') return t.network.mutual
  if (type === 'outgoing') return t.network.outgoing
  if (type === 'incoming') return t.network.incoming
  return ''
}

interface RenderNode extends GraphNode {
  x: number
  y: number
}

interface RenderEdge {
  id: string
  x1: number; y1: number
  x2: number; y2: number
  type: string
  sourceId: string
  targetId: string
}

const EXPANDED_W = 240
const EXPANDED_H = 80
// Kleinerer Glow des unexpandierten „me"-Nodes (`0 0 25px 8px …` ≈ 33px).
const ME_GLOW_MARGIN = 34

interface NetworkProps {
  /**
   * Eingebettet in einen Tab (z.B. Kontakte → Graph): keine Bottom-Hint-Zeile,
   * keine mobile FAB-Ausweichzone (der globale Connect-FAB liegt außerhalb des
   * 60vh-Containers). Die /network-Route rendert weiter die Vollseite.
   */
  embedded?: boolean
}

export function Network({ embedded = false }: NetworkProps = {}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  // Render state — updated by simulation ticks
  const [graph, setGraph] = useState<{ nodes: RenderNode[]; edges: RenderEdge[] }>({ nodes: [], edges: [] })

  const { nodes, edges, forceRefresh } = useNetworkGraph()
  const navigate = useNavigate()
  const { t } = useLanguage()

  // Beamer-Modus: solange die Network-Seite offen ist, die Cache-Einträge alle
  // 10s force-refreshen, damit der Graph live wächst. Page-lokal, sauber
  // aufgeräumt beim Unmount (useGraphLivePolling).
  useGraphLivePolling(forceRefresh)

  // Beamer-Modus: Graph-Container in den Vollbild-Modus schalten (Beamer). ESC
  // oder erneutes Toggle beendet ihn wieder.
  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
    } else {
      el.requestFullscreen().catch(() => {})
    }
  }, [])

  // Mutable refs for simulation internals (never read in render)
  const simulationRef = useRef<ReturnType<typeof forceSimulation<SimNode>> | null>(null)
  const simNodesRef = useRef<SimNode[]>([])
  // Kanten als Roh-Liste mit String-IDs (source/target). Bewusst getrennt von den
  // forceLink-Link-Objekten (die d3 intern zu Node-Refs mutiert): der Render liest
  // Positionen per ID aus simNodesRef, damit Node-Merge/Rescale die Kanten nicht
  // an veraltete Objekt-Refs bindet.
  const simEdgesRef = useRef<{ source: string; target: string; type: string }[]>([])
  // Layout-Signatur + zuletzt verwendete Dimensionen: entscheiden im Effect, ob
  // ein Update ein struktureller Merge, ein Rescale oder nur ein Render-Refresh ist.
  const layoutSigRef = useRef<string>('')
  const simDimsRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 })
  const dragState = useRef<{ id: string; offsetX: number; offsetY: number; moved: boolean } | null>(null)
  const selectedIdRef = useRef<string | null>(null)


  // Responsive sizing
  useEffect(() => {
    const el = containerRef.current
    const updateSize = () => {
      if (el) {
        const rect = el.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
          setDimensions(prev =>
            prev.width === rect.width && prev.height === rect.height
              ? prev
              : { width: rect.width, height: rect.height },
          )
        }
      }
    }
    const timer = setTimeout(updateSize, 50)
    window.addEventListener('resize', updateSize)
    // Tab-Wechsel/Embedded/Fullscreen ändern die Container-Größe OHNE window-resize
    // zu feuern (Codex #1) — ResizeObserver misst direkt am Container.
    const ro =
      el && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateSize) : null
    ro?.observe(el as Element)
    // Entering/leaving fullscreen resizes the graph container but may not fire a
    // window resize — re-measure on fullscreenchange (and once more after the
    // browser settles the fullscreen layout) so the simulation re-lays-out.
    const settleTimers: ReturnType<typeof setTimeout>[] = []
    const onFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement)
      updateSize()
      settleTimers.push(setTimeout(updateSize, 100))
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => {
      clearTimeout(timer)
      settleTimers.forEach(clearTimeout)
      window.removeEventListener('resize', updateSize)
      ro?.disconnect()
      document.removeEventListener('fullscreenchange', onFullscreenChange)
    }
  }, [])

  // Simulation nur beim Unmount stoppen — der Simulations-Effect unten verwendet
  // die Instanz über Datenpolls hinweg wieder und darf sie deshalb NICHT bei jedem
  // Re-Run stoppen (sonst friert der Graph nach dem ersten Poll ein).
  useEffect(() => {
    return () => {
      simulationRef.current?.stop()
    }
  }, [])

  // When a node expands, push neighbors away so they don't overlap
  useEffect(() => {
    selectedIdRef.current = selectedId
    const sim = simulationRef.current
    if (!sim || dimensions.width === 0) return
    const diagonal = Math.sqrt(dimensions.width ** 2 + dimensions.height ** 2)
    const scale = diagonal / 800

    sim.force('collision', forceCollide<SimNode>()
      .radius(d => {
        if (d.id === selectedId) return Math.max(EXPANDED_W, EXPANDED_H) / 2 + 20
        return d.size * scale + 40
      })
      .strength(1)
      .iterations(3)
    )
    // Gentle nudge — just enough to resolve overlaps, not enough to rearrange
    sim.alpha(0.08).alphaTarget(0).restart()
  }, [selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Force simulation (Fix B — Positions-Erhalt statt Kreis-Reset).
  //
  // Der Effect hängt an nodes/edges/dimensions. Bei JEDEM Live-Poll liefert
  // useNetworkGraph neue Objekt-Refs, obwohl sich strukturell nichts ändert. Ohne
  // Unterscheidung würde jeder Poll das Layout neu aufbauen (Kreis-Start, alpha
  // 0.4) und von Hand gezogene / eingeschwungene Knoten neu ins Layout reißen.
  // Deshalb via layoutSignature + Dimensions-Vergleich vier Fälle trennen:
  //   1) Erstaufbau, 2) Struktur-Änderung (Merge + sanftes Reheat),
  //   3) nur Dimensions-Änderung (proportionales Rescale), 4) reiner Daten-Refresh
  //      (nur Render-Felder, KEIN Reheat, KEIN Reposition).
  useEffect(() => {
    if (nodes.length === 0 || dimensions.width === 0) return

    const { width, height } = dimensions
    const diagonal = Math.sqrt(width * width + height * height)
    const scale = diagonal / 800

    const signature = layoutSignature(nodes, edges)
    const prevSig = layoutSigRef.current
    const prevDims = simDimsRef.current
    const sim = simulationRef.current
    const sigChanged = prevSig !== signature
    const dimsChanged = prevDims.width !== width || prevDims.height !== height

    // Label-Breiten messen (horizontales Clamping / Padding pro Knoten).
    const measureLabels = (sn: readonly SimNode[]): Map<string, number> => {
      const map = new Map<string, number>()
      const ctx = document.createElement('canvas').getContext('2d')
      if (ctx) {
        sn.forEach(d => {
          ctx.font = d.type === 'me' ? '600 13px system-ui' : '400 11px system-ui'
          map.set(d.id, ctx.measureText(d.label).width)
        })
      }
      return map
    }

    // FAB-Ausweichzone: nur mobil UND NICHT eingebettet — im 60vh-Tab liegt der
    // globale Connect-FAB (AppShell) außerhalb des Containers (Codex #7).
    const applyFabZone = !embedded && width < 768
    const fabX = width - 44  // right-4 + w-14/2
    const fabY = height - 52 // bottom-20 + offset + h-14/2
    const fabRadius = 50     // FAB radius + padding

    const makeClamp = (labelWidths: Map<string, number>) => (d: SimNode) => {
      const isExpanded = d.id === selectedIdRef.current
      const labelHalf = (labelWidths.get(d.id) || 0) / 2 + 5
      // „me" ist nie expandiert, hat aber einen (kleineren) Glow → seine Basis-
      // Reserve muss ME_GLOW_MARGIN mindestens abdecken, sonst klippt sein Glow.
      const meReserve = d.type === 'me' ? ME_GLOW_MARGIN : 0
      const basePx = Math.max(d.size + 5, labelHalf, meReserve)
      const basePy = Math.max(d.size + 5, meReserve)
      // Expandierter Node: nur die KARTE bleibt voll sichtbar (Halbmaße + kleine
      // Reserve). Den vollen Glow (~110px) einzurechnen hat den Node in schmalen
      // Panels eingesperrt (nicht mehr an den Rand ziehbar); der weiche Halo darf
      // am Container-Rand klippen, das fällt visuell nicht auf.
      let px = isExpanded ? Math.max(EXPANDED_W / 2 + 6, basePx) : basePx
      let py = isExpanded ? Math.max(EXPANDED_H / 2 + 6, basePy) : basePy
      // Narrow-Screen-Guard: auf sehr schmalen Viewports würde die Reserve die
      // Clamp-Grenzen überkreuzen (px > width-px) und den Node an den Rand pinnen.
      // Deckeln auf die halbe Fläche → die Karte zentriert sich statt zu klippen;
      // die Karte selbst bleibt immer voll sichtbar.
      px = Math.min(px, width / 2)
      py = Math.min(py, height / 2)
      d.x = Math.max(px, Math.min(width - px, d.x))
      d.y = Math.max(py, Math.min(height - py, d.y))

      if (applyFabZone) {
        const dx = d.x - fabX
        const dy = d.y - fabY
        const dist = Math.sqrt(dx * dx + dy * dy)
        const minDist = fabRadius + d.size
        if (dist < minDist && dist > 0) {
          const push = (minDist - dist) / dist
          d.x += dx * push
          d.y += dy * push
        }
      }
    }

    // Render-Push: Positionen aus simNodesRef in den React-State. Kanten per ID
    // auflösen (entkoppelt von den forceLink-internen Link-Objekten), damit
    // Merge/Rescale die Kanten nicht an veraltete Node-Refs binden.
    const makeRunTick = (clamp: (d: SimNode) => void) => () => {
      const arr = simNodesRef.current
      arr.forEach(clamp)
      const byId = new Map(arr.map(d => [d.id, d]))
      setGraph({
        nodes: arr.map(d => ({ ...d, x: d.x, y: d.y })),
        edges: simEdgesRef.current.flatMap((e): RenderEdge[] => {
          const src = byId.get(e.source)
          const tgt = byId.get(e.target)
          if (!src || !tgt) return []
          return [{
            id: `${src.id}-${tgt.id}`,
            x1: src.x, y1: src.y,
            x2: tgt.x, y2: tgt.y,
            type: e.type,
            sourceId: src.id,
            targetId: tgt.id,
          }]
        }),
      })
    }

    // Kanonische Roh-Kanten (String-IDs) für Render + frische forceLink-Kopien.
    const nextEdges = edges.map(e => ({ source: e.source, target: e.target, type: e.type }))
    const makeLinkForce = () =>
      forceLink(nextEdges.map(e => ({ ...e }))).id((d: any) => d.id)
        .distance((d: any) => d.type === 'mutual' ? 160 * scale : 220 * scale)
        .strength((d: any) => d.type === 'mutual' ? 0.25 : 0.1)

    // Selection-aware Collision (identisch zum Selection-Effect): nach Merge/Rescale
    // neu anwenden, damit ein expandierter Knoten seinen Freiraum behält (Codex #5).
    const applyCollision = (target: NonNullable<typeof sim>) => {
      target.force('collision', forceCollide<SimNode>()
        .radius(d => d.id === selectedIdRef.current
          ? Math.max(EXPANDED_W, EXPANDED_H) / 2 + 20
          : d.size * scale + 40)
        .strength(1)
        .iterations(3))
    }

    const pinMe = (sn: readonly SimNode[]) => {
      const me = sn.find(n => n.type === 'me')
      if (me) { me.fx = width / 2; me.fy = height / 2 }
    }

    // ── Fall 1: Erstaufbau (noch keine Simulation) ───────────────────────────
    if (!sim) {
      const simNodes = mergeSimNodes([], nodes, dimensions)
      pinMe(simNodes)
      simNodesRef.current = simNodes
      simEdgesRef.current = nextEdges
      const clamp = makeClamp(measureLabels(simNodes))

      const simulation = forceSimulation(simNodes)
        .force('link', makeLinkForce())
        .force('charge', forceManyBody().strength(-1200 * scale).distanceMin(80))
        .force('collision', forceCollide<SimNode>().radius(d => d.size * scale + 60).strength(1))
        .force('x', forceX(width / 2).strength(0.03))
        .force('y', forceY(height / 2).strength(0.03))
        .alpha(0.4)
        .alphaDecay(0.05)
        .velocityDecay(0.5)
        .stop() // don't auto-run yet

      // Pre-compute stable layout synchronously (no visual jitter)
      for (let i = 0; i < 120; i++) simulation.tick()
      simNodes.forEach(clamp)

      simulationRef.current = simulation
      // Start at rest — only wakes on drag/interaction. Listener VOR restart
      // registrieren, damit der eine Tick aus restart den Initial-Render auslöst.
      simulation.on('tick', makeRunTick(clamp))
      simulation.alpha(0).restart()

      layoutSigRef.current = signature
      simDimsRef.current = { width, height }
      return
    }

    // ── Fall 2: Struktur-Änderung (neue/entfernte Knoten oder Kanten) ─────────
    if (sigChanged) {
      // Kombinierter Trigger (Poll UND Resize/Fullscreen gleichzeitig): die
      // bestehenden ABSOLUTEN Positionen zuerst in den neuen Koordinatenraum
      // rescalen, DANN mergen — sonst würden die Vorgänger-Positionen im alten
      // Raum committet (Sprung). Bei reiner Struktur-Änderung ist prevBase == aktuell.
      const prevBase = dimsChanged
        ? rescaleSimNodes(simNodesRef.current, prevDims, dimensions)
        : simNodesRef.current
      const merged = mergeSimNodes(prevBase, nodes, dimensions)
      pinMe(merged)
      simNodesRef.current = merged
      simEdgesRef.current = nextEdges
      const clamp = makeClamp(measureLabels(merged))

      // Instanz WIEDERVERWENDEN: Nodes/Links tauschen, Kräfte an aktuelle Skala
      // angleichen, alten Tick-Listener durch den neuen ERSETZEN (d3 ersetzt
      // gleichnamige Listener → kein Doppel-Listener / Leak).
      sim.nodes(merged)
      sim.force('link', makeLinkForce())
      sim.force('charge', forceManyBody().strength(-1200 * scale).distanceMin(80))
      sim.force('x', forceX(width / 2).strength(0.03))
      sim.force('y', forceY(height / 2).strength(0.03))
      applyCollision(sim)
      sim.on('tick', makeRunTick(clamp))
      // Sanftes Reheat: bestehende Knoten wandern kaum, nur Neue fügen sich ein.
      sim.alpha(0.1).alphaTarget(0).restart()

      layoutSigRef.current = signature
      simDimsRef.current = { width, height }
      return
    }

    // ── Fall 3: Nur Dimensions-Änderung (Tab/Fullscreen/Embedded-Resize) ──────
    if (dimsChanged) {
      const rescaled = rescaleSimNodes(simNodesRef.current, prevDims, dimensions)
      simNodesRef.current = rescaled
      const clamp = makeClamp(measureLabels(rescaled))

      sim.nodes(rescaled)
      sim.force('link', makeLinkForce())
      sim.force('charge', forceManyBody().strength(-1200 * scale).distanceMin(80))
      sim.force('x', forceX(width / 2).strength(0.03))
      sim.force('y', forceY(height / 2).strength(0.03))
      applyCollision(sim)
      rescaled.forEach(clamp)
      sim.on('tick', makeRunTick(clamp))
      // KEIN Kreis-Reset — nur sanft nachsetzen lassen.
      sim.alpha(0.05).alphaTarget(0).restart()

      simDimsRef.current = { width, height }
      return
    }

    // ── Fall 4: Reiner Daten-Refresh (Label/Avatar/Counts) ───────────────────
    // Signatur + Dimensionen unverändert → Layout NICHT anfassen: nur die
    // render-relevanten Felder der bestehenden Knoten aktualisieren (Position/
    // Velocity/Pin bewahren) und EINMAL neu zeichnen. Kein Reheat, kein Reposition.
    const nextById = new Map(nodes.map(n => [n.id, n]))
    simNodesRef.current.forEach(sn => {
      const nn = nextById.get(sn.id)
      if (!nn) return
      const { x, y, vx, vy, fx, fy } = sn
      Object.assign(sn, nn)
      sn.x = x; sn.y = y; sn.vx = vx; sn.vy = vy; sn.fx = fx; sn.fy = fy
    })
    simEdgesRef.current = nextEdges
    const clamp = makeClamp(measureLabels(simNodesRef.current))
    sim.on('tick', makeRunTick(clamp))
    makeRunTick(clamp)()
  }, [nodes, edges, dimensions, embedded])

  // Pointer handlers for drag + click
  const onPointerDown = useCallback((e: React.PointerEvent, nodeId: string) => {
    // Don't intercept clicks on buttons/links inside expanded cards
    const target = e.target as HTMLElement
    if (target.closest('button') || target.closest('a')) return

    e.stopPropagation()

    const node = simNodesRef.current.find(n => n.id === nodeId)
    if (!node || !containerRef.current) return

    const rect = containerRef.current.getBoundingClientRect()
    dragState.current = {
      id: nodeId,
      offsetX: e.clientX - rect.left - node.x,
      offsetY: e.clientY - rect.top - node.y,
      moved: false,
    }
    node.fx = node.x
    node.fy = node.y
    simulationRef.current?.alphaTarget(0.15).restart()

    const onMove = (ev: PointerEvent) => {
      const ds = dragState.current
      if (!ds || !containerRef.current) return
      const r = containerRef.current.getBoundingClientRect()
      const n = simNodesRef.current.find(nd => nd.id === ds.id)
      if (!n) return

      const newX = ev.clientX - r.left - ds.offsetX
      const newY = ev.clientY - r.top - ds.offsetY
      if (!ds.moved && (Math.abs(newX - n.x) > 3 || Math.abs(newY - n.y) > 3)) {
        ds.moved = true
      }
      n.fx = newX
      n.fy = newY
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)

      const ds = dragState.current
      if (!ds) return

      const n = simNodesRef.current.find(nd => nd.id === ds.id)
      simulationRef.current?.alphaTarget(0)

      if (n && n.type !== 'me' && ds.moved) {
        // Keep pinned at drop position — user dragged intentionally
        // Node stays fixed until next layout event (selection change, new data)
      } else if (n && n.type !== 'me') {
        n.fx = null
        n.fy = null
      }

      if (!ds.moved) {
        const wasAlreadyOpen = selectedId === ds.id
        if (wasAlreadyOpen) {
          // Already open → navigate to profile
          navigate(`/p/${encodeURIComponent(ds.id)}`)
        } else {
          // Closed → open it
          setSelectedId(ds.id)
        }
      }
      dragState.current = null
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [selectedId, navigate])

  // Empty state = nur der „me"-Knoten (noch keine Kontakte). WICHTIG: der
  // gemessene Container wird IMMER gerendert (mit ref), nur der Inhalt wechselt
  // zwischen Empty-State und Graph — sonst würde der ResizeObserver beim
  // Empty→Graph-Übergang ein entferntes Element weitermessen (stale dimensions,
  // erster Kontakt sizet nicht korrekt).
  const isEmpty = nodes.length <= 1 && dimensions.width > 0

  return (
    <div
      className="flex flex-col h-full overflow-hidden"
    >
      <div
        ref={containerRef}
        className="relative flex-1 select-none"
        style={{
          touchAction: 'none',
          // Beamer-Modus: theme-treuer App-Hintergrund (Fix A) statt fix-dunkel —
          // Light-Theme bleibt hell, Dark-Theme dunkel. Beamer-Nutzen (Vollbild +
          // größere Labels) bleibt, nur kein erzwungenes Dunkel mehr.
          ...(isFullscreen ? { background: 'var(--background)' } : {}),
        }}
        onClick={() => setSelectedId(null)}
      >
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center h-full">
            <div className="relative mb-8">
              <svg width="120" height="120" viewBox="0 0 120 120">
                <defs>
                  <radialGradient id="me-glow">
                    <stop offset="0%" stopColor="oklch(0.65 0.18 45)" stopOpacity="0.4" />
                    <stop offset="100%" stopColor="oklch(0.65 0.18 45)" stopOpacity="0" />
                  </radialGradient>
                </defs>
                <circle cx="60" cy="60" r="50" fill="url(#me-glow)">
                  <animate attributeName="r" values="40;50;40" dur="4s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.3;0.6;0.3" dur="4s" repeatCount="indefinite" />
                </circle>
                <circle cx="60" cy="60" r="24" fill="var(--color-muted, #1e293b)" stroke="oklch(0.65 0.18 45)" strokeWidth="1.5" strokeOpacity="0.3" />
                <circle cx="60" cy="60" r="16" fill="oklch(0.65 0.18 45)" opacity="0.6" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold text-foreground mb-2">{t.network.emptyTitle}</h2>
            <p className="text-muted-foreground text-center max-w-xs mb-6">{t.network.emptyText}</p>
            <button
              onClick={e => { e.stopPropagation(); navigate('/verify') }}
              className="flex items-center gap-2 px-5 py-3 bg-primary text-primary-foreground font-medium rounded-xl hover:bg-primary/90 transition-colors"
            >
              <UserPlus size={18} />
              {t.network.connect}
            </button>
          </div>
        ) : (
        <>
        {/* Beamer-Modus umschalten (unauffällig, oben rechts) */}
        <button
          onClick={e => { e.stopPropagation(); toggleFullscreen() }}
          className="absolute top-3 right-3 z-30 p-2 rounded-lg text-muted-foreground/60 hover:text-foreground hover:bg-foreground/5 transition-colors"
          title={isFullscreen ? t.network.exitBeamer : t.network.beamerMode}
          aria-label={isFullscreen ? t.network.exitBeamer : t.network.beamerMode}
        >
          {isFullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
        </button>

        {/* SVG: edges (behind nodes) */}
        <svg
          viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
          className="absolute inset-0 w-full h-full pointer-events-none"
          style={{ zIndex: 0 }}
        >
          <defs>
            <marker id="arrow-amber" viewBox="0 -4 8 8" refX="8" refY="0" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,-3L8,0L0,3" fill="#f59e0b" />
            </marker>
            <marker id="arrow-blue" viewBox="0 -4 8 8" refX="8" refY="0" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,-3L8,0L0,3" fill="#3b82f6" />
            </marker>
            <marker id="arrow-gray" viewBox="0 -4 8 8" refX="8" refY="0" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,-3L8,0L0,3" fill="currentColor" opacity="0.3" />
            </marker>
          </defs>
          {graph.edges.map(edge => {
            const isConnected = !!selectedId && (edge.sourceId === selectedId || edge.targetId === selectedId)

            const srcNode = graph.nodes.find(n => n.id === edge.sourceId)
            const tgtNode = graph.nodes.find(n => n.id === edge.targetId)

            const dx = edge.x2 - edge.x1
            const dy = edge.y2 - edge.y1
            const dist = Math.sqrt(dx * dx + dy * dy)
            if (dist < 1) return null

            const ux = dx / dist
            const uy = dy / dist

            // For expanded cards, compute distance to rectangle edge
            const rectEdgeDist = (nodeId: string | undefined, nodeSize: number) => {
              if (nodeId === selectedId) {
                // Ray-rectangle intersection: half-width and half-height
                const hw = EXPANDED_W / 2, hh = EXPANDED_H / 2
                const absUx = Math.abs(ux), absUy = Math.abs(uy)
                if (absUx < 0.001) return hh + 4
                if (absUy < 0.001) return hw + 4
                return Math.min(hw / absUx, hh / absUy) + 4
              }
              return nodeSize + 2
            }

            const srcR = srcNode ? rectEdgeDist(srcNode.id, srcNode.size) : 0
            const tgtR = tgtNode ? rectEdgeDist(tgtNode.id, tgtNode.size) : 0

            const x1 = edge.x1 + ux * srcR
            const y1 = edge.y1 + uy * srcR
            const x2 = edge.x2 - ux * tgtR
            const y2 = edge.y2 - uy * tgtR

            // Edge color based on type
            const edgeColor = edge.type === 'mutual' ? 'var(--color-success, #059669)'
              : edge.type === 'outgoing' ? '#f59e0b'
              : '#3b82f6'

            // Arrow markers for directional edges (always marker-end)
            const hasArrow = edge.type !== 'mutual'
            const arrowId = isConnected
              ? (edge.type === 'outgoing' ? 'arrow-amber' : edge.type === 'incoming' ? 'arrow-blue' : '')
              : 'arrow-gray'

            // For incoming edges, swap line direction so arrow points toward "me" (source)
            const [lx1, ly1, lx2, ly2] = edge.type === 'incoming'
              ? [x2, y2, x1, y1]
              : [x1, y1, x2, y2]

            const strokeProps = {
              stroke: isConnected ? edgeColor : 'currentColor',
              // Grundkontrast der grauen Kanten angehoben, damit das Netz auch ohne
              // Auswahl gut sichtbar ist (currentColor trägt in hell + dunkel).
              // Verbundene Kanten (0.6) stechen weiterhin klar hervor.
              strokeOpacity: selectedId ? (isConnected ? 0.6 : 0.15) : 0.22,
              strokeWidth: isConnected ? 2 : 1,
              markerEnd: hasArrow ? `url(#${arrowId})` : undefined,
              style: { transition: 'stroke-opacity 0.3s, stroke-width 0.3s, stroke 0.3s' } as React.CSSProperties,
              strokeLinecap: 'round' as const,
            }

            return (
              <g key={edge.id}>
                <line x1={lx1} y1={ly1} x2={lx2} y2={ly2} {...strokeProps} />
              </g>
            )
          })}
        </svg>

        {/* Edge badges temporarily disabled for testing */}

        {/* Nodes */}
        {graph.nodes.map(node => {
          const isSelected = node.id === selectedId
          const dimmed = false
          const r = node.size
          // Placeholder-Nodes (kein Avatar, nicht „me") tragen Ring + Füllung in
          // EINER deterministischen Kontaktlisten-Farbe. Avatare + „me" (Gold,
          // hue 45) behalten das Hue-System unverändert.
          const usePlaceholder = !node.avatar && node.type !== 'me'
          const accentAlpha = (a: number) =>
            usePlaceholder
              ? hexAlpha(PLACEHOLDER_ACCENTS[getColorIndex(node.label)], a)
              : nodeColorAlpha(node.hue, a)

          return (
            <div key={node.id}>
              {/* Node: collapsed circle OR expanded card — glow via box-shadow */}
              <div
                onPointerDown={e => onPointerDown(e, node.id)}
                onClick={e => e.stopPropagation()}
                className="absolute cursor-grab active:cursor-grabbing"
                style={{
                  left: node.x,
                  top: node.y,
                  width: isSelected ? EXPANDED_W : r * 2,
                  height: isSelected ? EXPANDED_H : r * 2,
                  transform: 'translate(-50%, -50%)',
                  borderRadius: isSelected ? 12 : '50%',
                  background: isSelected ? 'var(--color-card, #1e293b)' : 'var(--color-muted, #1e293b)',
                  border: `${node.type === 'pending' ? 1 : 1.5}px ${node.type === 'pending' ? 'dashed' : 'solid'} ${accentAlpha(isSelected ? 0.3 : node.type === 'pending' ? 0.2 : 0.3)}`,
                  boxShadow: isSelected
                    ? `0 0 40px 15px ${accentAlpha(0.25)}, 0 0 80px 30px ${accentAlpha(0.1)}`
                    : node.type === 'me'
                      ? `0 0 25px 8px ${accentAlpha(0.15)}`
                      : 'none',
                  transition: 'width 0.35s cubic-bezier(0.34, 1.56, 0.64, 1), height 0.35s cubic-bezier(0.34, 1.56, 0.64, 1), border-radius 0.35s, border-color 0.3s, opacity 0.3s, box-shadow 0.35s',
                  opacity: dimmed ? 0.35 : 1,
                  overflow: 'hidden',
                  zIndex: isSelected ? 20 : node.type === 'me' ? 10 : 5,
                }}
              >
                {/* Collapsed: avatar, „me"-Kern (Gold) oder Kontaktlisten-Placeholder */}
                {!isSelected && (
                  <div className="w-full h-full flex items-center justify-center">
                    {node.avatar ? (
                      <img
                        src={node.avatar}
                        alt={node.label}
                        draggable={false}
                        className="rounded-full object-cover pointer-events-none"
                        style={{
                          width: node.size * 1.6,
                          height: node.size * 1.6,
                          opacity: node.type === 'pending' ? 0.4 : 1,
                        }}
                      />
                    ) : node.type === 'me' ? (
                      // „me"-Sonderfarbe (Gold, hue 45) bleibt unverändert.
                      <div
                        className="rounded-full"
                        style={{
                          width: node.size * 1.3,
                          height: node.size * 1.3,
                          background: nodeColor(node.hue),
                          opacity: 0.7,
                        }}
                      />
                    ) : (
                      // Identisch zur Kontaktliste: Initialen + dieselbe
                      // deterministische Farbe (colors[getColorIndex(name)]).
                      <div
                        className={`${colors[getColorIndex(node.label)]} rounded-full flex items-center justify-center font-semibold pointer-events-none`}
                        style={{
                          width: node.size * 1.6,
                          height: node.size * 1.6,
                          fontSize: Math.max(9, node.size * 0.7),
                          opacity: node.type === 'pending' ? 0.4 : 1,
                        }}
                      >
                        {getInitials(node.label)}
                      </div>
                    )}
                  </div>
                )}

                {/* Expanded: ContactCard-style layout */}
                {isSelected && (
                  <div className="p-4 flex items-center gap-3 h-full w-full">
                    <div className="flex-shrink-0 pointer-events-none">
                      <Avatar name={node.label} avatar={node.avatar} size="sm" />
                    </div>
                    <div className="flex-1 min-w-0 overflow-hidden">
                      <div className="flex items-center gap-2 pointer-events-none">
                        <span className="font-medium text-foreground text-sm truncate">
                          {node.label}
                        </span>
                        {node.type !== 'me' && node.verificationStatus !== 'none' && (() => {
                          const badgeConfig = {
                            mutual: { color: 'bg-success/15 text-success', icon: ArrowLeftRight },
                            incoming: { color: 'bg-blue-100 text-blue-700', icon: ArrowDownLeft },
                            outgoing: { color: 'bg-amber-100 text-amber-700', icon: ArrowUpRight },
                          }
                          const cfg = badgeConfig[node.verificationStatus as keyof typeof badgeConfig]
                          if (!cfg) return null
                          const Icon = cfg.icon
                          return (
                            <span className={`text-xs px-1.5 py-0.5 rounded-full flex-shrink-0 flex items-center ${cfg.color}`}>
                              <Icon size={12} />
                            </span>
                          )
                        })()}
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground/70">
                        {node.type !== 'me' && node.verificationCount > 0 && (
                          <span className="flex items-center gap-1">
                            <Users size={11} />
                            {node.verificationCount}
                          </span>
                        )}
                        {node.type !== 'me' && node.attestationCount > 0 && (
                          <span className="flex items-center gap-1">
                            <Award size={11} />
                            {node.attestationCount}
                          </span>
                        )}
                        {node.type === 'me' && (
                          <>
                            <span className="flex items-center gap-1">
                              <Users size={11} />
                              {nodes.length - 1}
                            </span>
                            {node.attestationCount > 0 && (
                              <span className="flex items-center gap-1">
                                <Award size={11} />
                                {node.attestationCount}
                              </span>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                    {node.type !== 'me' && (
                      <button
                        onClick={e => { e.stopPropagation(); navigate(`/attestations/new?to=${encodeURIComponent(node.id)}`) }}
                        className="p-2 text-muted-foreground/70 hover:text-accent-600 hover:bg-accent-50 rounded-lg transition-colors flex-shrink-0"
                        title={t.network.createAttestation}
                      >
                        <Award size={18} />
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Label below circle (hidden when expanded) */}
              {!isSelected && (
                <div
                  className="absolute pointer-events-none text-center"
                  style={{
                    left: node.x,
                    top: node.y + node.size + 8,
                    transform: 'translateX(-50%)',
                    opacity: dimmed ? 0.25 : node.type === 'pending' ? 0.5 : 1,
                    zIndex: 4,
                  }}
                >
                  <span
                    className="text-foreground whitespace-nowrap"
                    style={{
                      // Beamer-Modus: nur größere Labels. Farbe bleibt theme-treu
                      // (text-foreground), passend zum theme-treuen Hintergrund (Fix
                      // A) — sonst wären helle Labels im Light-Theme unsichtbar.
                      fontSize: (node.type === 'me' ? 13 : 11) * (isFullscreen ? 1.8 : 1),
                      fontWeight: node.type === 'me' ? 600 : 400,
                    }}
                  >
                    {node.label}
                  </span>
                </div>
              )}
            </div>
          )
        })}
        </>
        )}
      </div>

      {!embedded && (
        <div className="text-center py-2 text-xs text-muted-foreground/50 shrink-0">
          {t.network.hint}
        </div>
      )}
    </div>
  )
}
