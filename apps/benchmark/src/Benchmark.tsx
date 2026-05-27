/**
 * In-Browser CRDT Benchmark Page
 *
 * Runs Automerge vs Yjs benchmarks directly in the browser.
 * Access via /benchmark — no login required.
 * Measures real-world performance on the actual device (including mobile WASM).
 */
import { useState } from 'react'
import * as Y from 'yjs'

// Automerge is loaded dynamically to measure WASM init time
type AutomergeModule = typeof import('@automerge/automerge')

interface BenchmarkResult {
  crdt: string
  scenario: string
  initMs: number
  mutate1Ms: number
  mutate100Ms: number
  serializeMs: number
  snapshotSize: number
}

// --- Data Generators ---

function generateContact(i: number) {
  return {
    did: `did:key:z6Mkcontact${i}`,
    publicKey: `pubkey-${i}-${'x'.repeat(40)}`,
    name: `Contact ${i}`,
    avatar: i % 3 === 0 ? `https://avatar.example.com/user-${i}.png` : '',
    bio: `Bio for contact ${i} — involved in project ${i % 10}`,
    status: i % 5 === 0 ? 'pending' : 'active',
    verifiedAt: i % 5 === 0 ? '' : new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function generateAttestation(i: number) {
  return {
    id: `att-${i}`,
    attestationId: `attestation-id-${i}`,
    fromDid: `did:key:attester-${i % 20}`,
    toDid: 'did:key:z6MkmyDid',
    claim: `Attestation #${i}: ${['JS', 'Rust', 'Design', 'Leadership', 'Cooking', 'Teaching', 'Mentoring', 'Research'][i % 8]}`,
    tagsJson: JSON.stringify([['dev', 'rust', 'design', 'lead', 'food', 'teach', 'mentor', 'research'][i % 8]]),
    context: ['work', 'community', 'personal'][i % 3],
    createdAt: new Date().toISOString(),
    vcJws: `header.payload-${i}.signature`,
  }
}

// --- Yjs Benchmark ---

function runYjsBenchmark(contacts: number, attestations: number): BenchmarkResult {
  // Create doc with data
  const setupDoc = new Y.Doc()
  setupDoc.transact(() => {
    const pm = setupDoc.getMap('profile')
    pm.set('did', 'did:key:z6MkmyDid')
    pm.set('name', 'Benchmark User')
    pm.set('bio', 'Testing')
    const cm = setupDoc.getMap('contacts')
    for (let i = 0; i < contacts; i++) {
      const c = generateContact(i)
      const m = new Y.Map()
      for (const [k, v] of Object.entries(c)) m.set(k, v)
      cm.set(c.did, m)
    }
    const am = setupDoc.getMap('attestations')
    for (let i = 0; i < attestations; i++) {
      const a = generateAttestation(i)
      const m = new Y.Map()
      for (const [k, v] of Object.entries(a)) m.set(k, v)
      am.set(a.id, m)
    }
  })
  const binary = Y.encodeStateAsUpdate(setupDoc)
  setupDoc.destroy()

  // Init
  const t0 = performance.now()
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, binary)
  const initMs = performance.now() - t0

  const contactsMap = ydoc.getMap('contacts')

  // Single mutation
  const t1 = performance.now()
  ydoc.transact(() => {
    const m = new Y.Map()
    const c = generateContact(9999)
    for (const [k, v] of Object.entries(c)) m.set(k, v)
    contactsMap.set('did:key:z6Mknew', m)
  })
  const mutate1Ms = performance.now() - t1

  // Batch mutation
  const t2 = performance.now()
  ydoc.transact(() => {
    for (let i = 0; i < 100; i++) {
      const m = new Y.Map()
      const c = generateContact(10000 + i)
      for (const [k, v] of Object.entries(c)) m.set(k, v)
      contactsMap.set(`did:key:z6Mkbatch${i}`, m)
    }
  })
  const mutate100Ms = performance.now() - t2

  // Serialize
  const t3 = performance.now()
  const saved = Y.encodeStateAsUpdate(ydoc)
  const serializeMs = performance.now() - t3

  ydoc.destroy()

  return {
    crdt: 'Yjs',
    scenario: `${contacts}c + ${attestations}a`,
    initMs: Math.round(initMs * 10) / 10,
    mutate1Ms: Math.round(mutate1Ms * 10) / 10,
    mutate100Ms: Math.round(mutate100Ms * 10) / 10,
    serializeMs: Math.round(serializeMs * 10) / 10,
    snapshotSize: saved.length,
  }
}

// --- Automerge Benchmark ---

async function runAutomergeBenchmark(contacts: number, attestations: number): Promise<BenchmarkResult> {
  // Dynamic import — measures real WASM load time on first call
  const Automerge: AutomergeModule = await import('@automerge/automerge')

  // Create doc with data
  let doc = Automerge.from<any>({
    profile: { did: 'did:key:z6MkmyDid', name: 'Benchmark User', bio: 'Testing' },
    contacts: {},
    attestations: {},
  })
  doc = Automerge.change(doc, (d: any) => {
    for (let i = 0; i < contacts; i++) {
      const c = generateContact(i)
      d.contacts[c.did] = c
    }
    for (let i = 0; i < attestations; i++) {
      const a = generateAttestation(i)
      d.attestations[a.id] = a
    }
  })
  const binary = Automerge.save(doc)

  // Init
  const t0 = performance.now()
  const loaded = Automerge.load<any>(binary)
  const initMs = performance.now() - t0

  // Single mutation
  const t1 = performance.now()
  const doc2 = Automerge.change(loaded, (d: any) => {
    d.contacts['did:key:z6Mknew'] = generateContact(9999)
  })
  const mutate1Ms = performance.now() - t1

  // Batch mutation
  const t2 = performance.now()
  Automerge.change(doc2, (d: any) => {
    for (let i = 0; i < 100; i++) {
      d.contacts[`did:key:z6Mkbatch${i}`] = generateContact(10000 + i)
    }
  })
  const mutate100Ms = performance.now() - t2

  // Serialize
  const t3 = performance.now()
  const saved = Automerge.save(loaded)
  const serializeMs = performance.now() - t3

  return {
    crdt: 'Automerge',
    scenario: `${contacts}c + ${attestations}a`,
    initMs: Math.round(initMs * 10) / 10,
    mutate1Ms: Math.round(mutate1Ms * 10) / 10,
    mutate100Ms: Math.round(mutate100Ms * 10) / 10,
    serializeMs: Math.round(serializeMs * 10) / 10,
    snapshotSize: saved.length,
  }
}

// --- Format Helpers ---

function formatMs(ms: number): string {
  if (ms < 1) return '<1ms'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function speedup(slow: number, fast: number): string {
  if (fast === 0) return '—'
  const x = slow / fast
  if (x < 1.1) return '~1x'
  return `${x.toFixed(0)}x`
}

// --- Component ---

const SCENARIOS = [
  { name: 'Small', contacts: 10, attestations: 5 },
  { name: 'Medium', contacts: 100, attestations: 50 },
  { name: 'Large', contacts: 500, attestations: 1000 },
]

export function Benchmark() {
  const [results, setResults] = useState<BenchmarkResult[]>([])
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState('')
  const [wasmInitMs, setWasmInitMs] = useState<number | null>(null)

  async function runAll() {
    setRunning(true)
    setResults([])
    const allResults: BenchmarkResult[] = []

    // Measure WASM init (first Automerge import)
    setStatus('Loading Automerge WASM...')
    const t0wasm = performance.now()
    await import('@automerge/automerge')
    const wasmMs = Math.round(performance.now() - t0wasm)
    setWasmInitMs(wasmMs)

    for (const s of SCENARIOS) {
      // Yjs
      setStatus(`Yjs — ${s.name} (${s.contacts}c + ${s.attestations}a)...`)
      await new Promise(r => setTimeout(r, 50)) // yield to UI
      const yjsResult = runYjsBenchmark(s.contacts, s.attestations)
      allResults.push(yjsResult)
      setResults([...allResults])

      // Automerge
      setStatus(`Automerge — ${s.name} (${s.contacts}c + ${s.attestations}a)...`)
      await new Promise(r => setTimeout(r, 50))
      const amResult = await runAutomergeBenchmark(s.contacts, s.attestations)
      allResults.push(amResult)
      setResults([...allResults])
    }

    setStatus('Done!')
    setRunning(false)
  }

  const grouped = SCENARIOS.map(s => {
    const key = `${s.contacts}c + ${s.attestations}a`
    const yjs = results.find(r => r.crdt === 'Yjs' && r.scenario === key)
    const am = results.find(r => r.crdt === 'Automerge' && r.scenario === key)
    return { ...s, yjs, am }
  })

  return (
    <div className="max-w-3xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-2">CRDT Benchmark</h1>
      <p className="text-muted-foreground mb-6 text-sm">
        Measures Automerge (Rust→WASM) vs Yjs (pure JS) performance directly on this device.
      </p>

      <button
        onClick={runAll}
        disabled={running}
        className="px-6 py-3 bg-primary-600 text-white font-medium rounded-lg hover:bg-primary-700 disabled:opacity-50 mb-6"
      >
        {running ? status : 'Run Benchmark'}
      </button>

      {wasmInitMs !== null && (
        <p className="text-sm text-muted-foreground mb-4">
          WASM init: <span className="font-mono font-medium text-foreground">{formatMs(wasmInitMs)}</span>
          <span className="ml-2 text-xs">(Yjs: no WASM needed)</span>
        </p>
      )}

      {results.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 pr-3 text-muted-foreground font-medium">Scenario</th>
                <th className="text-left py-2 pr-3 text-muted-foreground font-medium">CRDT</th>
                <th className="text-right py-2 pr-3 text-muted-foreground font-medium">Init</th>
                <th className="text-right py-2 pr-3 text-muted-foreground font-medium">Mutate 1</th>
                <th className="text-right py-2 pr-3 text-muted-foreground font-medium">Mutate 100</th>
                <th className="text-right py-2 pr-3 text-muted-foreground font-medium">Serialize</th>
                <th className="text-right py-2 text-muted-foreground font-medium">Size</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map(g => (
                <>
                  {g.yjs && (
                    <tr key={`yjs-${g.name}`} className="border-b border-border/50">
                      <td className="py-2 pr-3 font-medium" rowSpan={g.am ? 2 : 1}>{g.name}</td>
                      <td className="py-2 pr-3 text-success font-medium">Yjs</td>
                      <td className="py-2 pr-3 text-right font-mono">{formatMs(g.yjs.initMs)}</td>
                      <td className="py-2 pr-3 text-right font-mono">{formatMs(g.yjs.mutate1Ms)}</td>
                      <td className="py-2 pr-3 text-right font-mono">{formatMs(g.yjs.mutate100Ms)}</td>
                      <td className="py-2 pr-3 text-right font-mono">{formatMs(g.yjs.serializeMs)}</td>
                      <td className="py-2 text-right font-mono">{formatSize(g.yjs.snapshotSize)}</td>
                    </tr>
                  )}
                  {g.am && (
                    <tr key={`am-${g.name}`} className="border-b border-border">
                      {!g.yjs && <td className="py-2 pr-3 font-medium">{g.name}</td>}
                      <td className="py-2 pr-3 text-primary-500 font-medium">Automerge</td>
                      <td className="py-2 pr-3 text-right font-mono">{formatMs(g.am.initMs)}</td>
                      <td className="py-2 pr-3 text-right font-mono">{formatMs(g.am.mutate1Ms)}</td>
                      <td className="py-2 pr-3 text-right font-mono">{formatMs(g.am.mutate100Ms)}</td>
                      <td className="py-2 pr-3 text-right font-mono">{formatMs(g.am.serializeMs)}</td>
                      <td className="py-2 text-right font-mono">{formatSize(g.am.snapshotSize)}</td>
                    </tr>
                  )}
                  {g.yjs && g.am && (
                    <tr key={`diff-${g.name}`} className="border-b-2 border-border bg-muted/30">
                      <td className="py-1 pr-3 text-xs text-muted-foreground" colSpan={2}>Speedup</td>
                      <td className="py-1 pr-3 text-right text-xs font-mono font-medium text-success">{speedup(g.am.initMs, g.yjs.initMs)}</td>
                      <td className="py-1 pr-3 text-right text-xs font-mono font-medium text-success">{speedup(g.am.mutate1Ms, g.yjs.mutate1Ms)}</td>
                      <td className="py-1 pr-3 text-right text-xs font-mono font-medium text-success">{speedup(g.am.mutate100Ms, g.yjs.mutate100Ms)}</td>
                      <td className="py-1 pr-3 text-right text-xs font-mono font-medium text-success">{speedup(g.am.serializeMs, g.yjs.serializeMs)}</td>
                      <td className="py-1 text-right text-xs font-mono text-muted-foreground">{speedup(g.yjs.snapshotSize, g.am.snapshotSize)} smaller</td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Legend */}
      <div className="mt-8 bg-muted/50 border border-border rounded-lg p-4 space-y-3 text-sm">
        <h3 className="font-semibold text-foreground">Scenarios</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-muted-foreground">
          <div>
            <span className="font-medium text-foreground">Small</span>
            <br />10 contacts, 5 attestations
            <br />Typical new user
          </div>
          <div>
            <span className="font-medium text-foreground">Medium</span>
            <br />100 contacts, 50 attestations
            <br />Active community member
          </div>
          <div>
            <span className="font-medium text-foreground">Large</span>
            <br />500 contacts, 1000 attestations
            <br />Power user / community hub
          </div>
        </div>

        <h3 className="font-semibold text-foreground pt-2">Metrics</h3>
        <div className="space-y-1 text-muted-foreground text-xs">
          <p><span className="font-medium text-foreground">Init</span> — Load a serialized document into memory (simulates app start)</p>
          <p><span className="font-medium text-foreground">Mutate 1</span> — Add a single contact</p>
          <p><span className="font-medium text-foreground">Mutate 100</span> — Add 100 contacts in one transaction</p>
          <p><span className="font-medium text-foreground">Serialize</span> — Save document to binary (for IndexedDB / network)</p>
          <p><span className="font-medium text-foreground">Size</span> — Serialized snapshot size in bytes</p>
          <p><span className="font-medium text-foreground">WASM init</span> — One-time cost to load and compile Automerge's WebAssembly module (Yjs has no WASM)</p>
        </div>

        <h3 className="font-semibold text-foreground pt-2">About</h3>
        <p className="text-xs text-muted-foreground">
          <a href="https://automerge.org" className="underline" target="_blank" rel="noreferrer">Automerge</a> is a Rust-based CRDT compiled to WebAssembly (~1.7MB).{' '}
          <a href="https://yjs.dev" className="underline" target="_blank" rel="noreferrer">Yjs</a> is a pure JavaScript CRDT (~69KB).{' '}
          Both are used in the <a href="https://github.com/antontranelis/web-of-trust" className="underline" target="_blank" rel="noreferrer">Web of Trust</a> project
          for offline-first, end-to-end encrypted personal data.
        </p>
      </div>

      <p className="text-xs text-muted-foreground mt-4">
        {navigator.userAgent}
      </p>
    </div>
  )
}
