import { useEffect, useRef, useState } from 'react'
import * as d3 from 'd3'

// === Konzepte mit individuellen Farben (OKLCH für konsistente Helligkeit) ===
const concepts = [
  {
    id: 'wot',
    label: 'Web of Trust',
    hue: 45,       // warmes Gold — Zentrum, Vertrauen
    size: 22,
    description: 'Ein dezentrales Netzwerk, in dem Vertrauen nicht von Institutionen vergeben wird — sondern von Mensch zu Mensch wächst. Jede Verbindung basiert auf einer echten Begegnung.',
  },
  {
    id: 'gemeinschaft',
    label: 'Gemeinschaft',
    hue: 25,       // warmes Orange — Wärme, Zusammenhalt
    size: 16,
    description: 'Menschen, die sich gegenseitig kennen und füreinander einstehen. Nicht abstrakt, sondern konkret — in Nachbarschaften, Projekten, Netzwerken.',
  },
  {
    id: 'unterstuetzung',
    label: 'Unterstützung',
    hue: 160,      // Türkis — Fürsorge, Heilung
    size: 14,
    description: 'Hilfe, die ankommt, weil sie von Menschen kommt, die dich kennen. Keine Formulare, keine Wartelisten — echte Unterstützung durch echte Beziehungen.',
  },
  {
    id: 'zukunft',
    label: 'Zukunft',
    hue: 200,      // helles Blau — Horizont, Weite
    size: 14,
    description: 'Eine Welt, in der Zusammenarbeit auf Vertrauen statt auf Kontrolle basiert. Technologie, die Menschen verbindet statt überwacht.',
  },
  {
    id: 'hoffnung',
    label: 'Hoffnung',
    hue: 135,      // frisches Grün — Wachstum, Neubeginn
    size: 13,
    description: 'Das Wissen, dass es anders geht. Dass wir Strukturen bauen können, die auf Vertrauen und Begegnung statt auf Misstrauen und Kontrolle setzen.',
  },
  {
    id: 'freunde',
    label: 'Freunde',
    hue: 340,      // warmes Rosa — Herzlichkeit, Nähe
    size: 15,
    description: 'Die Basis von allem. Freundschaft ist die ursprünglichste Form von Vertrauen — und das Fundament jedes Web of Trust.',
  },
  {
    id: 'kreativitaet',
    label: 'Kreativität',
    hue: 300,      // Violett — Inspiration, Fantasie
    size: 14,
    description: 'In sicheren Räumen entsteht Neues. Wer vertraut wird, traut sich — neue Ideen, ungewöhnliche Wege, gemeinsame Experimente.',
  },
  {
    id: 'lebendigkeit',
    label: 'Lebendigkeit',
    hue: 80,       // Limettengrün — Energie, Vitalität
    size: 13,
    description: 'Ein Netzwerk, das lebt und atmet. Kein starres System, sondern ein organisches Geflecht, das mit seinen Teilnehmern wächst.',
  },
  {
    id: 'sicherheit',
    label: 'Sicherheit',
    hue: 240,      // tiefes Blau — Stabilität, Schutz
    size: 14,
    description: 'Nicht durch Mauern, sondern durch Beziehungen. Wer eingebettet ist in ein Netz des Vertrauens, ist geschützt — digital und analog.',
  },
  {
    id: 'wertschoepfung',
    label: 'Wertschöpfung',
    hue: 55,       // Bernstein — Substanz, Ertrag
    size: 15,
    description: 'Zusammenarbeit auf Augenhöhe schafft echten Wert. Projekte entstehen, Fähigkeiten werden geteilt, Ressourcen fließen dorthin, wo sie gebraucht werden.',
  },
  {
    id: 'projekte',
    label: 'Projekte',
    hue: 15,       // Terracotta — Tatkraft, Handwerk
    size: 15,
    description: 'Gemeinsame Vorhaben, die aus Vertrauen entstehen. Ob Nachbarschaftsgarten oder Open-Source-Software — Projekte sind gelebte Gemeinschaft.',
  },
  {
    id: 'verbindung',
    label: 'Verbindung',
    hue: 270,      // Lavendel — Brücke, Begegnung
    size: 14,
    description: 'Der Moment, in dem zwei Menschen sich wirklich begegnen. Im Web of Trust wird diese Verbindung kryptographisch bezeugt — aber sie bleibt menschlich.',
  },
  {
    id: 'freude',
    label: 'Freude',
    hue: 60,       // Sonnengelb — Leichtigkeit, Lachen
    size: 13,
    description: 'Die natürliche Folge von Verbindung. Wer Teil eines lebendigen Netzwerks ist, erlebt Freude — an Begegnungen, an gemeinsamen Erfolgen, am Miteinander.',
  },
  {
    id: 'freiheit',
    label: 'Freiheit',
    hue: 190,      // Cyan — offener Himmel, Weite
    size: 14,
    description: 'Selbstbestimmte Identität. Keine Plattform entscheidet, wer du bist. Du kontrollierst deine Daten, deine Beziehungen, deine digitale Existenz.',
  },
  {
    id: 'verantwortung',
    label: 'Verantwortung',
    hue: 220,      // Stahlblau — Verlässlichkeit, Haltung
    size: 14,
    description: 'Vertrauen ist keine Einbahnstraße. Wer Teil des Netzwerks ist, trägt Verantwortung — für die eigene Integrität und für die Gemeinschaft.',
  },
]

// Farbe aus Hue ableiten — konsistente Helligkeit und Sättigung
function nodeColor(hue) {
  return `oklch(0.65 0.18 ${hue})`
}
function nodeGlow(hue) {
  return `oklch(0.65 0.18 ${hue} / 0.35)`
}

// Kanten mit ganzen Sätzen in beide Richtungen
// sentence: "Subject verb Object" — forward = source→target, reverse = target→source
const relations = [
  // Web of Trust — Zentrum
  { source: 'wot', target: 'gemeinschaft',
    sentence: 'Das Web of Trust lässt Gemeinschaft wachsen.',
    reverse: 'Gemeinschaft ist das Herzstück des Web of Trust.' },
  { source: 'wot', target: 'sicherheit',
    sentence: 'Das Web of Trust schafft Sicherheit durch Beziehungen.',
    reverse: 'Sicherheit macht das Web of Trust vertrauenswürdig.' },
  { source: 'wot', target: 'freiheit',
    sentence: 'Das Web of Trust ermöglicht digitale Freiheit.',
    reverse: 'Freiheit ist ein Grundprinzip des Web of Trust.' },
  { source: 'wot', target: 'verbindung',
    sentence: 'Das Web of Trust basiert auf echten Verbindungen.',
    reverse: 'Jede Verbindung stärkt das Web of Trust.' },
  { source: 'wot', target: 'freunde',
    sentence: 'Das Web of Trust verbindet Freunde digital.',
    reverse: 'Freunde bilden das Fundament des Web of Trust.' },
  { source: 'wot', target: 'wertschoepfung',
    sentence: 'Das Web of Trust fördert gemeinsame Wertschöpfung.',
    reverse: 'Wertschöpfung zeigt die Kraft des Web of Trust.' },
  { source: 'wot', target: 'verantwortung',
    sentence: 'Das Web of Trust braucht Verantwortung.',
    reverse: 'Verantwortung hält das Web of Trust lebendig.' },

  // Gemeinschaft
  { source: 'gemeinschaft', target: 'unterstuetzung',
    sentence: 'Gemeinschaft bietet echte Unterstützung.',
    reverse: 'Unterstützung stärkt die Gemeinschaft.' },
  { source: 'gemeinschaft', target: 'zukunft',
    sentence: 'Gemeinschaft gestaltet die Zukunft.',
    reverse: 'Die Zukunft braucht starke Gemeinschaften.' },
  { source: 'gemeinschaft', target: 'projekte',
    sentence: 'Aus Gemeinschaft entstehen Projekte.',
    reverse: 'Projekte schweißen die Gemeinschaft zusammen.' },

  // Freunde
  { source: 'freunde', target: 'hoffnung',
    sentence: 'Freunde schenken einander Hoffnung.',
    reverse: 'Hoffnung entsteht zwischen Freunden.' },
  { source: 'freunde', target: 'verbindung',
    sentence: 'Freunde entstehen durch echte Verbindung.',
    reverse: 'Verbindung lässt Freundschaften wachsen.' },
  { source: 'freunde', target: 'freude',
    sentence: 'Freunde bringen einander Freude.',
    reverse: 'Freude vertieft Freundschaften.' },
  { source: 'freunde', target: 'projekte',
    sentence: 'Freunde machen zusammen Projekte.',
    reverse: 'Projekte führen zu neuen Freundschaften.' },

  // Verbindung
  { source: 'verbindung', target: 'freude',
    sentence: 'Echte Verbindung erzeugt Freude.',
    reverse: 'Freude entsteht aus Verbindung.' },
  { source: 'verbindung', target: 'projekte',
    sentence: 'Verbindungen führen zu gemeinsamen Projekten.',
    reverse: 'Projekte schaffen neue Verbindungen.' },

  // Projekte
  { source: 'projekte', target: 'wertschoepfung',
    sentence: 'Projekte erzeugen echte Wertschöpfung.',
    reverse: 'Wertschöpfung ermöglicht neue Projekte.' },
  { source: 'projekte', target: 'kreativitaet',
    sentence: 'Projekte brauchen Kreativität.',
    reverse: 'Kreativität findet in Projekten ihren Ausdruck.' },

  // Kreativität
  { source: 'kreativitaet', target: 'lebendigkeit',
    sentence: 'Kreativität erzeugt Lebendigkeit.',
    reverse: 'Lebendigkeit inspiriert zu Kreativität.' },

  // Sicherheit
  { source: 'sicherheit', target: 'freiheit',
    sentence: 'Sicherheit ermöglicht echte Freiheit.',
    reverse: 'Freiheit braucht ein Fundament aus Sicherheit.' },
  { source: 'sicherheit', target: 'kreativitaet',
    sentence: 'Sicherheit fördert Kreativität.',
    reverse: 'Kreativität braucht sichere Räume.' },

  // Wertschöpfung
  { source: 'wertschoepfung', target: 'zukunft',
    sentence: 'Wertschöpfung baut an der Zukunft.',
    reverse: 'Die Zukunft entsteht durch gemeinsame Wertschöpfung.' },

  // Verantwortung
  { source: 'verantwortung', target: 'sicherheit',
    sentence: 'Verantwortung schafft Sicherheit.',
    reverse: 'Sicherheit entsteht durch Verantwortung füreinander.' },
  { source: 'verantwortung', target: 'gemeinschaft',
    sentence: 'Verantwortung stärkt die Gemeinschaft.',
    reverse: 'Gemeinschaft fördert Verantwortungsbewusstsein.' },

  // Hoffnung
  { source: 'hoffnung', target: 'zukunft',
    sentence: 'Hoffnung weist den Weg in die Zukunft.',
    reverse: 'Die Zukunft gibt Hoffnung.' },

  // Lebendigkeit
  { source: 'lebendigkeit', target: 'freude',
    sentence: 'Lebendigkeit bringt Freude.',
    reverse: 'Freude macht das Netzwerk lebendig.' },

  // Unterstützung
  { source: 'unterstuetzung', target: 'sicherheit',
    sentence: 'Gegenseitige Unterstützung gibt Sicherheit.',
    reverse: 'Sicherheit entsteht durch Unterstützung.' },
]


export default function SemanticNetwork() {
  const svgRef = useRef(null)
  const containerRef = useRef(null)
  const [selected, setSelected] = useState(null)
  const [dimensions, setDimensions] = useState({ width: 900, height: 600 })

  // Responsive sizing — measure actual container
  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect()
        setDimensions({ width: rect.width, height: rect.height })
      }
    }
    // Wait a frame for flex layout to settle
    requestAnimationFrame(updateSize)
    window.addEventListener('resize', updateSize)
    return () => window.removeEventListener('resize', updateSize)
  }, [])

  useEffect(() => {
    if (!svgRef.current) return

    const { width, height } = dimensions
    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    // Deep copy data for D3 mutation
    const nodes = concepts.map(d => ({ ...d }))
    const links = relations.map(d => ({ ...d }))

    // Scale forces to fill available space — use diagonal as reference
    const diagonal = Math.sqrt(width * width + height * height)
    const scale = diagonal / 800
    const simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(d => d.id).distance(60 * scale + 50).strength(0.3))
      .force('charge', d3.forceManyBody().strength(-500 * scale).distanceMin(30))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius(d => d.size * scale + 20).strength(0.8))
      .force('x', d3.forceX(width / 2).strength(0.015))
      .force('y', d3.forceY(height / 2).strength(0.015))

    // Defs for per-node glows
    const defs = svg.append('defs')
    nodes.forEach(d => {
      const grad = defs.append('radialGradient').attr('id', `glow-${d.id}`)
      grad.append('stop').attr('offset', '0%').attr('stop-color', nodeColor(d.hue)).attr('stop-opacity', 0.4)
      grad.append('stop').attr('offset', '100%').attr('stop-color', nodeColor(d.hue)).attr('stop-opacity', 0)
    })

    // Links
    const link = svg.append('g')
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', 'currentColor')
      .attr('stroke-opacity', 0.15)
      .attr('stroke-width', 1.5)
      .attr('class', 'text-foreground')

    // Edge labels — show short version of sentence on hover
    const edgeLabel = svg.append('g')
      .selectAll('text')
      .data(links)
      .join('text')
      .attr('font-size', 9)
      .attr('fill', 'currentColor')
      .attr('fill-opacity', 0)
      .attr('text-anchor', 'middle')
      .attr('class', 'text-muted-foreground pointer-events-none')
      .style('font-family', 'inherit')

    // Node groups
    const node = svg.append('g')
      .selectAll('g')
      .data(nodes)
      .join('g')
      .style('cursor', 'pointer')
      .call(d3.drag()
        .on('start', (event, d) => {
          if (!event.active) simulation.alphaTarget(0.3).restart()
          d.fx = d.x
          d.fy = d.y
        })
        .on('drag', (event, d) => {
          d.fx = event.x
          d.fy = event.y
        })
        .on('end', (event, d) => {
          if (!event.active) simulation.alphaTarget(0)
          d.fx = null
          d.fy = null
        })
      )

    // Glow circle
    node.append('circle')
      .attr('r', d => d.size + 12)
      .attr('fill', d => `url(#glow-${d.id})`)
      .attr('opacity', 0)
      .attr('class', 'glow-circle')

    // Background circle
    node.append('circle')
      .attr('r', d => d.size)
      .attr('fill', 'var(--color-muted, #1e293b)')
      .attr('stroke', d => nodeColor(d.hue))
      .attr('stroke-width', 1.5)
      .attr('stroke-opacity', 0.3)

    // Colored core
    node.append('circle')
      .attr('r', d => d.size * 0.65)
      .attr('fill', d => nodeColor(d.hue))
      .attr('opacity', 0.5)
      .attr('class', 'core-circle')

    // Label
    node.append('text')
      .text(d => d.label)
      .attr('text-anchor', 'middle')
      .attr('dy', d => d.size + 16)
      .attr('font-size', d => d.id === 'wot' ? 13 : 11)
      .attr('font-weight', d => d.id === 'wot' ? 600 : 400)
      .attr('fill', 'currentColor')
      .attr('class', 'text-foreground')
      .style('font-family', 'inherit')
      .style('pointer-events', 'none')

    // Hover & Click
    node
      .on('mouseenter', function (event, d) {
        d3.select(this).select('.glow-circle').transition().duration(200).attr('opacity', 1)
        d3.select(this).select('.core-circle').transition().duration(200).attr('opacity', 0.85)

        // Show edge labels with direction-aware sentence
        edgeLabel
          .text(l => {
            const srcId = l.source.id || l.source
            const tgtId = l.target.id || l.target
            if (srcId === d.id) return l.sentence
            if (tgtId === d.id) return l.reverse
            return ''
          })
          .transition().duration(200)
          .attr('fill-opacity', l => {
            const srcId = l.source.id || l.source
            const tgtId = l.target.id || l.target
            return (srcId === d.id || tgtId === d.id) ? 0.7 : 0
          })

        link.transition().duration(200)
          .attr('stroke-opacity', l => {
            const srcId = l.source.id || l.source
            const tgtId = l.target.id || l.target
            return (srcId === d.id || tgtId === d.id) ? 0.5 : 0.08
          })
          .attr('stroke-width', l => {
            const srcId = l.source.id || l.source
            const tgtId = l.target.id || l.target
            return (srcId === d.id || tgtId === d.id) ? 2.5 : 1
          })
      })
      .on('mouseleave', function () {
        d3.select(this).select('.glow-circle').transition().duration(300).attr('opacity', 0)
        d3.select(this).select('.core-circle').transition().duration(300).attr('opacity', 0.5)
        edgeLabel.transition().duration(300).attr('fill-opacity', 0)
        link.transition().duration(300).attr('stroke-opacity', 0.15).attr('stroke-width', 1.5)
      })
      .on('click', (event, d) => {
        event.stopPropagation()
        setSelected(prev => prev?.id === d.id ? null : d)
      })

    // Click on background to deselect
    svg.on('click', () => setSelected(null))

    simulation.on('tick', () => {
      // Clamp nodes within bounds with comfortable padding
      const pad = 60
      nodes.forEach(d => {
        d.x = Math.max(d.size + pad, Math.min(width - d.size - pad, d.x))
        d.y = Math.max(d.size + pad, Math.min(height - d.size - pad, d.y))
      })

      link
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x)
        .attr('y2', d => d.target.y)

      edgeLabel
        .attr('x', d => (d.source.x + d.target.x) / 2)
        .attr('y', d => (d.source.y + d.target.y) / 2 - 4)

      node.attr('transform', d => `translate(${d.x},${d.y})`)
    })

    return () => simulation.stop()
  }, [dimensions])

  const selectedConcept = selected ? concepts.find(c => c.id === selected.id) : null
  const connectedTo = selected
    ? relations
        .filter(r => r.source === selected.id || r.target === selected.id)
        .map(r => {
          const isSource = r.source === selected.id
          return {
            concept: isSource ? r.target : r.source,
            sentence: isSource ? r.sentence : r.reverse,
          }
        })
    : []

  const sectionRef = useRef(null)

  return (
    <section
      ref={sectionRef}
      className="h-screen snap-start snap-always relative flex flex-col bg-muted"
      style={{ scrollSnapAlign: 'start' }}
    >
      {/* Header — compact, overlaying the top */}
      <div className="text-center pt-6 pb-4 px-4 shrink-0">
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground mb-2">
          Ein positives Verstärkungsnetzwerk
        </h1>
        <p className="text-sm md:text-base text-muted-foreground leading-relaxed max-w-2xl mx-auto">
          Jeder Wert stärkt die anderen. Klicke auf einen Knoten, um die Zusammenhänge zu entdecken.
        </p>
      </div>

      {/* Graph — fills remaining space */}
      <div ref={containerRef} className="relative flex-1 mx-3 mb-3 rounded-2xl overflow-hidden bg-background/50 backdrop-blur border border-border">
        <svg
          ref={svgRef}
          width={dimensions.width}
          height={dimensions.height}
          className="w-full h-full dark:brightness-110"
        />

        {/* Info Panel */}
        {selectedConcept && (
          <div
            className="absolute bottom-4 left-4 right-4 md:left-auto md:right-4 md:top-4 md:bottom-auto md:w-80 max-h-[calc(100%-2rem)] overflow-y-auto bg-background/95 backdrop-blur-lg rounded-xl border border-border p-5 shadow-xl transition-all"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-3">
              <div
                className="w-4 h-4 rounded-full shrink-0"
                style={{ backgroundColor: nodeColor(selectedConcept.hue) }}
              />
              <h3 className="text-lg font-semibold text-foreground">{selectedConcept.label}</h3>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed mb-4">
              {selectedConcept.description}
            </p>
            {connectedTo.length > 0 && (
              <div className="border-t border-border pt-3">
                <p className="text-xs text-muted-foreground/60 uppercase tracking-wide mb-2">Verbindungen</p>
                <div className="space-y-1.5">
                  {connectedTo.map(({ concept, sentence }) => {
                    const target = concepts.find(n => n.id === concept)
                    return (
                      <button
                        key={concept}
                        className="w-full text-left text-sm px-3 py-1.5 rounded-lg bg-muted hover:bg-muted-foreground/10 text-muted-foreground transition-colors flex items-start gap-2"
                        onClick={() => {
                          if (target) setSelected(target)
                        }}
                      >
                        <span
                          className="w-2 h-2 rounded-full mt-1.5 shrink-0"
                          style={{ backgroundColor: target ? nodeColor(target.hue) : undefined }}
                        />
                        <span>{sentence}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
            <button
              onClick={() => setSelected(null)}
              className="absolute top-3 right-3 text-muted-foreground/50 hover:text-foreground transition-colors"
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {/* Hint */}
      <div className="text-center pb-4 text-xs text-muted-foreground/50 shrink-0">
        Knoten anklicken oder ziehen
      </div>
    </section>
  )
}
