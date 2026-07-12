import { describe, it, expect } from 'vitest'
import type { GraphNode, GraphEdge } from '../hooks/useNetworkGraph'
import {
  layoutSignature,
  mergeSimNodes,
  rescaleSimNodes,
  type SimNode,
} from './network-layout'

function node(id: string, over: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    label: id,
    type: 'active',
    size: 14,
    hue: 100,
    verificationStatus: 'none',
    verificationCount: 0,
    attestationCount: 0,
    sharedSpaces: [],
    ...over,
  }
}

function edge(source: string, target: string, type: GraphEdge['type'] = 'mutual'): GraphEdge {
  return { source, target, type }
}

const DIMS = { width: 800, height: 600 }

describe('layoutSignature', () => {
  it('is stable across new object refs with identical structure', () => {
    const nodesA = [node('me', { type: 'me', size: 28 }), node('a'), node('b')]
    const edgesA = [edge('me', 'a', 'outgoing'), edge('a', 'b')]
    // fresh objects, different array order (structurally identical)
    const nodesB = [node('b'), node('me', { type: 'me', size: 28 }), node('a')]
    const edgesB = [edge('a', 'b'), edge('me', 'a', 'outgoing')]

    expect(layoutSignature(nodesA, edgesA)).toBe(layoutSignature(nodesB, edgesB))
  })

  it('ignores render-only fields (label, avatar, counts)', () => {
    const base = [node('me', { type: 'me', size: 28 }), node('a')]
    const relabeled = [
      node('me', { type: 'me', size: 28, label: 'Neuer Name', avatar: 'x' }),
      node('a', { label: 'Bob', verificationCount: 5, attestationCount: 3 }),
    ]
    expect(layoutSignature(base, [])).toBe(layoutSignature(relabeled, []))
  })

  it('changes when a new edge appears', () => {
    const nodes = [node('me', { type: 'me' }), node('a'), node('b')]
    const before = layoutSignature(nodes, [edge('me', 'a', 'outgoing')])
    const after = layoutSignature(nodes, [edge('me', 'a', 'outgoing'), edge('a', 'b')])
    expect(before).not.toBe(after)
  })

  it('changes when a node size or type changes (layout-relevant)', () => {
    const before = layoutSignature([node('a', { size: 14 })], [])
    const afterSize = layoutSignature([node('a', { size: 20 })], [])
    const afterType = layoutSignature([node('a', { type: 'pending' })], [])
    expect(afterSize).not.toBe(before)
    expect(afterType).not.toBe(before)
  })

  it('changes when a node is added or removed', () => {
    const before = layoutSignature([node('a'), node('b')], [])
    const after = layoutSignature([node('a')], [])
    expect(before).not.toBe(after)
  })
})

describe('mergeSimNodes', () => {
  it('preserves a dragged node position + pin across a same-signature data refresh', () => {
    // Simulate a node that was dragged (fx/fy pinned) and settled at (321, 111).
    const prev: SimNode[] = [
      { ...node('me', { type: 'me' }), x: 400, y: 300, fx: 400, fy: 300 },
      { ...node('a'), x: 321, y: 111, vx: 2, vy: -1, fx: 321, fy: 111 },
    ]
    // New data arrives as fresh objects (as useNetworkGraph would produce).
    const next: GraphNode[] = [node('me', { type: 'me' }), node('a', { label: 'updated' })]

    const merged = mergeSimNodes(prev, next, DIMS)
    const a = merged.find(n => n.id === 'a')!
    expect(a.x).toBe(321)
    expect(a.y).toBe(111)
    expect(a.vx).toBe(2)
    expect(a.vy).toBe(-1)
    // Drag pin survives — otherwise the node would spring back on the next poll.
    expect(a.fx).toBe(321)
    expect(a.fy).toBe(111)
    // Render-only field flows through.
    expect(a.label).toBe('updated')
  })

  it('places only genuinely new ids on the circle start, keeping existing ones put', () => {
    const prev: SimNode[] = [
      { ...node('me', { type: 'me' }), x: 400, y: 300, fx: 400, fy: 300 },
      { ...node('a'), x: 123, y: 456 },
    ]
    const next: GraphNode[] = [node('me', { type: 'me' }), node('a'), node('new')]

    const merged = mergeSimNodes(prev, next, DIMS)
    const a = merged.find(n => n.id === 'a')!
    const fresh = merged.find(n => n.id === 'new')!

    // Existing node stays exactly where it was.
    expect(a.x).toBe(123)
    expect(a.y).toBe(456)
    // New node gets a deterministic circle-start position (not 0/undefined).
    expect(Number.isFinite(fresh.x)).toBe(true)
    expect(Number.isFinite(fresh.y)).toBe(true)
    expect(fresh.x === 123 && fresh.y === 456).toBe(false)
    expect(fresh.fx).toBeUndefined()
  })

  it('starts a fresh me node at the center', () => {
    const merged = mergeSimNodes([], [node('me', { type: 'me' }), node('a')], DIMS)
    const me = merged.find(n => n.id === 'me')!
    expect(me.x).toBe(DIMS.width / 2)
    expect(me.y).toBe(DIMS.height / 2)
  })
})

describe('rescaleSimNodes', () => {
  it('re-centers me and scales others proportionally (no circle explosion)', () => {
    const prev: SimNode[] = [
      { ...node('me', { type: 'me' }), x: 400, y: 300, fx: 400, fy: 300 },
      { ...node('a'), x: 200, y: 150 },
    ]
    const rescaled = rescaleSimNodes(prev, { width: 800, height: 600 }, { width: 400, height: 300 })

    const me = rescaled.find(n => n.id === 'me')!
    expect(me.x).toBe(200) // new center
    expect(me.y).toBe(150)
    expect(me.fx).toBe(200)
    expect(me.fy).toBe(150)

    const a = rescaled.find(n => n.id === 'a')!
    // Proportional: halved dimensions → halved coordinates (topology preserved).
    expect(a.x).toBe(100)
    expect(a.y).toBe(75)
  })

  it('scales a dragged node pin proportionally too', () => {
    const prev: SimNode[] = [
      { ...node('a'), x: 200, y: 100, fx: 200, fy: 100 },
    ]
    const rescaled = rescaleSimNodes(prev, { width: 800, height: 400 }, { width: 400, height: 800 })
    const a = rescaled[0]
    expect(a.fx).toBe(100) // x halved
    expect(a.fy).toBe(200) // y doubled
  })

  it('is a no-op scale factor when previous dimensions were zero', () => {
    const prev: SimNode[] = [{ ...node('a'), x: 50, y: 60 }]
    const rescaled = rescaleSimNodes(prev, { width: 0, height: 0 }, { width: 400, height: 300 })
    // No divide-by-zero blowups: scale defaults to 1.
    expect(Number.isFinite(rescaled[0].x)).toBe(true)
    expect(rescaled[0].x).toBe(50)
    expect(rescaled[0].y).toBe(60)
  })
})
