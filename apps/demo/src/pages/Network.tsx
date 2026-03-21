import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { forceSimulation, forceLink, forceManyBody, forceCollide, forceX, forceY } from 'd3-force'
import { UserPlus, Award, Users, ArrowLeftRight, ArrowDownLeft, ArrowUpRight } from 'lucide-react'
import { useNetworkGraph, type GraphNode } from '../hooks/useNetworkGraph'
import { useLanguage } from '../i18n'
import { Avatar } from '../components/shared'

function nodeColor(hue: number): string {
  return `oklch(0.65 0.18 ${hue})`
}
function nodeColorAlpha(hue: number, alpha: number): string {
  return `oklch(0.65 0.18 ${hue} / ${alpha})`
}
function statusLabel(type: string, t: any): string {
  if (type === 'mutual') return t.network.mutual
  if (type === 'outgoing') return t.network.outgoing
  if (type === 'incoming') return t.network.incoming
  return ''
}

interface SimNode extends GraphNode {
  x: number
  y: number
  fx?: number | null | undefined
  fy?: number | null | undefined
  vx?: number | undefined
  vy?: number | undefined
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

export function Network() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Render state — updated by simulation ticks
  const [graph, setGraph] = useState<{ nodes: RenderNode[]; edges: RenderEdge[] }>({ nodes: [], edges: [] })

  const { nodes, edges } = useNetworkGraph()
  const navigate = useNavigate()
  const { t } = useLanguage()

  // Mutable refs for simulation internals (never read in render)
  const simulationRef = useRef<ReturnType<typeof forceSimulation<SimNode>> | null>(null)
  const simNodesRef = useRef<SimNode[]>([])
  const dragState = useRef<{ id: string; offsetX: number; offsetY: number; moved: boolean } | null>(null)
  const selectedIdRef = useRef<string | null>(null)


  // Responsive sizing
  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
          setDimensions({ width: rect.width, height: rect.height })
        }
      }
    }
    const timer = setTimeout(updateSize, 50)
    window.addEventListener('resize', updateSize)
    return () => { clearTimeout(timer); window.removeEventListener('resize', updateSize) }
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

  // Force simulation
  useEffect(() => {
    if (nodes.length === 0 || dimensions.width === 0) return

    const { width, height } = dimensions
    const diagonal = Math.sqrt(width * width + height * height)
    const scale = diagonal / 800

    const simNodes: SimNode[] = nodes.map((d, i) => {
      const angle = (i / nodes.length) * 2 * Math.PI
      const spread = Math.min(width, height) * 0.3
      return {
        ...d,
        x: width / 2 + (d.type === 'me' ? 0 : Math.cos(angle) * spread),
        y: height / 2 + (d.type === 'me' ? 0 : Math.sin(angle) * spread),
      }
    })

    const simEdges = edges.map(d => ({ ...d }) as { source: string | SimNode; target: string | SimNode; type: string })

    const meNode = simNodes.find(n => n.type === 'me')
    if (meNode) { meNode.fx = width / 2; meNode.fy = height / 2 }

    simNodesRef.current = simNodes

    // Measure label widths to compute per-node horizontal padding
    const labelWidths = new Map<string, number>()
    const measureCtx = document.createElement('canvas').getContext('2d')
    if (measureCtx) {
      simNodes.forEach(d => {
        measureCtx.font = d.type === 'me' ? '600 13px system-ui' : '400 11px system-ui'
        labelWidths.set(d.id, measureCtx.measureText(d.label).width)
      })
    }

    // FAB exclusion zone (mobile only): bottom-right corner
    const isMobile = width < 768
    const fabX = width - 44  // right-4 + w-14/2
    const fabY = height - 52 // bottom-20 + offset + h-14/2
    const fabRadius = 50     // FAB radius + padding

    const clampNode = (d: SimNode) => {
      const isExpanded = d.id === selectedIdRef.current
      const labelHalf = (labelWidths.get(d.id) || 0) / 2 + 5
      const basePx = Math.max(d.size + 5, labelHalf)
      const px = isExpanded ? Math.max(EXPANDED_W / 2 + 10, basePx) : basePx
      const py = isExpanded ? Math.max(EXPANDED_H / 2 + 10, d.size + 5) : d.size + 5
      d.x = Math.max(px, Math.min(width - px, d.x))
      d.y = Math.max(py, Math.min(height - py, d.y))

      // Push nodes away from FAB zone on mobile
      if (isMobile) {
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

    const simulation = forceSimulation(simNodes)
      .force('link', forceLink(simEdges).id((d: any) => d.id)
        .distance((d: any) => d.type === 'mutual' ? 160 * scale : 220 * scale)
        .strength((d: any) => d.type === 'mutual' ? 0.25 : 0.1))
      .force('charge', forceManyBody().strength(-1200 * scale).distanceMin(80))
      .force('collision', forceCollide<SimNode>().radius(d => d.size * scale + 60).strength(1))
      .force('x', forceX(width / 2).strength(0.03))
      .force('y', forceY(height / 2).strength(0.03))
      .alpha(0.4)
      .alphaDecay(0.05)
      .velocityDecay(0.5)
      .stop() // don't auto-run yet

    // Pre-compute stable layout synchronously (no visual jitter)
    for (let i = 0; i < 120; i++) {
      simulation.tick()
    }
    // Clamp after pre-computation
    simNodes.forEach(clampNode)

    simulationRef.current = simulation

    // Start at rest — only wakes on drag/interaction
    simulation.alpha(0).restart()
    simulation.on('tick', () => {
      simNodes.forEach(clampNode)

      // Copy positions into render state — single setState to keep nodes + edges in sync
      setGraph({
        nodes: simNodes.map(d => ({ ...d, x: d.x, y: d.y })),
        edges: simEdges.map(e => {
          const src = e.source as SimNode
          const tgt = e.target as SimNode
          return {
            id: `${src.id}-${tgt.id}`,
            x1: src.x, y1: src.y,
            x2: tgt.x, y2: tgt.y,
            type: e.type,
            sourceId: src.id,
            targetId: tgt.id,
          }
        }),
      })
    })

    return () => { simulation.stop() }
  }, [nodes, edges, dimensions])

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

  // Empty state
  if (nodes.length <= 1 && dimensions.width > 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full"
      >
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
          onClick={() => navigate('/verify')}
          className="flex items-center gap-2 px-5 py-3 bg-primary text-primary-foreground font-medium rounded-xl hover:bg-primary/90 transition-colors"
        >
          <UserPlus size={18} />
          {t.network.connect}
        </button>
      </div>
    )
  }

  return (
    <div
      className="flex flex-col h-full overflow-hidden"
    >
      <div
        ref={containerRef}
        className="relative flex-1 select-none"
        style={{ touchAction: 'none' }}
        onClick={() => setSelectedId(null)}
      >
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
              strokeOpacity: selectedId ? (isConnected ? 0.6 : 0.06) : 0.08,
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
                  border: `${node.type === 'pending' ? 1 : 1.5}px ${node.type === 'pending' ? 'dashed' : 'solid'} ${nodeColorAlpha(node.hue, isSelected ? 0.3 : node.type === 'pending' ? 0.2 : 0.3)}`,
                  boxShadow: isSelected
                    ? `0 0 40px 15px ${nodeColorAlpha(node.hue, 0.25)}, 0 0 80px 30px ${nodeColorAlpha(node.hue, 0.1)}`
                    : node.type === 'me'
                      ? `0 0 25px 8px ${nodeColorAlpha(node.hue, 0.15)}`
                      : 'none',
                  transition: 'width 0.35s cubic-bezier(0.34, 1.56, 0.64, 1), height 0.35s cubic-bezier(0.34, 1.56, 0.64, 1), border-radius 0.35s, border-color 0.3s, opacity 0.3s, box-shadow 0.35s',
                  opacity: dimmed ? 0.35 : 1,
                  overflow: 'hidden',
                  zIndex: isSelected ? 20 : node.type === 'me' ? 10 : 5,
                }}
              >
                {/* Collapsed: avatar or colored core */}
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
                    ) : (
                      <div
                        className="rounded-full"
                        style={{
                          width: node.size * 1.3,
                          height: node.size * 1.3,
                          background: nodeColor(node.hue),
                          opacity: node.type === 'pending' ? 0.25 : node.type === 'me' ? 0.7 : 0.5,
                        }}
                      />
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
                    style={{ fontSize: node.type === 'me' ? 13 : 11, fontWeight: node.type === 'me' ? 600 : 400 }}
                  >
                    {node.label}
                  </span>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="text-center py-2 text-xs text-muted-foreground/50 shrink-0">
        {t.network.hint}
      </div>
    </div>
  )
}
