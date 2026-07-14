import type { GraphNode, GraphEdge } from '../hooks/useNetworkGraph'

/**
 * Simulations-Knoten: GraphNode + die d3-force-Kinematik (Position/Velocity/Pin).
 * Ausgelagert nach hier, damit die Layout-Helfer pure + unit-testbar bleiben.
 */
export interface SimNode extends GraphNode {
  x: number
  y: number
  fx?: number | null | undefined
  fy?: number | null | undefined
  vx?: number | undefined
  vy?: number | undefined
}

export interface Dimensions {
  width: number
  height: number
}

/**
 * Kanonische Signatur der layout-relevanten Graph-Struktur.
 *
 * Zweck (Fix B): der Simulations-Effect hängt an `nodes`/`edges`, die bei jedem
 * Poll als NEUE Objekt-Refs entstehen (useNetworkGraph memoisiert). Ein reiner
 * Daten-Refresh (Label/Avatar geladen) darf das Layout NICHT anfassen. Nur wenn
 * sich die Struktur ändert (neuer/entfernter Knoten, geänderte Größe/Typ, neue
 * Kante), soll neu gemerged + sanft reheatet werden.
 *
 * Deshalb: ein deterministischer String NUR aus layout-relevanten Feldern
 * (Node-ID + size + type, sortiert) und den Kanten (source|target|type, sortiert)
 * — unabhängig von Objekt-Identität und render-only-Feldern (Avatar, Name, Counts).
 */
export function layoutSignature(
  nodes: readonly Pick<GraphNode, 'id' | 'size' | 'type'>[],
  edges: readonly Pick<GraphEdge, 'source' | 'target' | 'type'>[],
): string {
  const nodePart = nodes
    .map(n => `${n.id}:${n.size}:${n.type}`)
    .sort()
    .join(',')
  const edgePart = edges
    .map(e => `${e.source}|${e.target}|${e.type}`)
    .sort()
    .join(',')
  return `${nodePart}#${edgePart}`
}

/**
 * Merge neuer Knotendaten in die bestehende Simulation, unter Erhalt der
 * eingeschwungenen bzw. von Hand gezogenen Positionen.
 *
 * - Existiert die ID bereits → x/y/vx/vy UND fx/fy übernehmen. fx/fy zu erhalten
 *   ist essenziell: absichtlich gezogene Knoten bleiben gepinnt (Network.tsx
 *   Drag-Design), ein Daten-Poll darf sie nicht losreißen.
 * - Nur echte neue IDs bekommen eine Kreis-Startposition; „me" in der Mitte.
 *
 * Pure: keine Seiteneffekte, gibt frische SimNode-Objekte zurück.
 */
export function mergeSimNodes(
  prevSimNodes: readonly SimNode[],
  nextNodes: readonly GraphNode[],
  dims: Dimensions,
): SimNode[] {
  const { width, height } = dims
  const prevById = new Map(prevSimNodes.map(n => [n.id, n]))
  const spread = Math.min(width, height) * 0.4
  const count = nextNodes.length

  return nextNodes.map((d, i) => {
    const prev = prevById.get(d.id)
    if (prev) {
      return {
        ...d,
        x: prev.x,
        y: prev.y,
        vx: prev.vx,
        vy: prev.vy,
        fx: prev.fx,
        fy: prev.fy,
      }
    }
    const angle = (i / count) * 2 * Math.PI
    return {
      ...d,
      x: width / 2 + (d.type === 'me' ? 0 : Math.cos(angle) * spread),
      y: height / 2 + (d.type === 'me' ? 0 : Math.sin(angle) * spread),
    }
  })
}

/**
 * Bei reiner Dimensions-Änderung (Tab-Wechsel/Fullscreen/Embedded): bestehende
 * Positionen proportional auf die neue Fläche skalieren statt Kreis-Reset.
 *
 * - `me` wird auf das neue Zentrum re-zentriert (und dort gepinnt).
 * - Alle anderen (inkl. gezogener fx/fy) proportional zur Größenänderung skaliert,
 *   damit die eingeschwungene Topologie erhalten bleibt (keine Kreis-Explosion).
 *
 * Pure: gibt frische SimNode-Objekte zurück.
 */
export function rescaleSimNodes(
  prevSimNodes: readonly SimNode[],
  prevDims: Dimensions,
  nextDims: Dimensions,
): SimNode[] {
  const sx = prevDims.width > 0 ? nextDims.width / prevDims.width : 1
  const sy = prevDims.height > 0 ? nextDims.height / prevDims.height : 1
  const cx = nextDims.width / 2
  const cy = nextDims.height / 2

  return prevSimNodes.map(d => {
    if (d.type === 'me') {
      return { ...d, x: cx, y: cy, fx: cx, fy: cy }
    }
    return {
      ...d,
      x: d.x * sx,
      y: d.y * sy,
      fx: d.fx != null ? d.fx * sx : d.fx,
      fy: d.fy != null ? d.fy * sy : d.fy,
    }
  })
}
