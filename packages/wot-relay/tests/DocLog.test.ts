import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { DocLog } from '../src/log-store.js'
import { protocol, WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core'

// Slice R / Sync 002 durable-log store unit tests. Entries are REAL log-entry
// JWS (encryptLogPayload + createLogEntryJws over a raw-seed Ed25519 identity),
// so verifyLogEntryJws-derived coordinates and content hashing match production.

const crypto = new WebCryptoProtocolCryptoAdapter()
const FIXED_TIMESTAMP = '2026-06-22T10:00:00Z'

interface Author {
  seed: Uint8Array
  did: string
  authorKid: string
}

async function makeAuthor(label: string): Promise<Author> {
  const seed = await crypto.sha256(new TextEncoder().encode(`doclog-test/seed/${label}`))
  const pub = await crypto.ed25519PublicKeyFromSeed(seed)
  const did = protocol.publicKeyToDidKey(pub)
  return { seed, did, authorKid: `${did}#sig-0` }
}

async function deriveKey(docId: string, generation = 0): Promise<Uint8Array> {
  return crypto.sha256(new TextEncoder().encode(`sck|${docId}|gen${generation}`))
}

/** Build a real log-entry JWS for (docId, author, deviceId, seq). */
async function makeEntryJws(params: {
  author: Author
  docId: string
  deviceId: string
  seq: number
  plaintext: string
  keyGeneration?: number
}): Promise<string> {
  const generation = params.keyGeneration ?? 0
  const spaceContentKey = await deriveKey(params.docId, generation)
  const enc = await protocol.encryptLogPayload({
    crypto,
    spaceContentKey,
    deviceId: params.deviceId,
    seq: params.seq,
    plaintext: new TextEncoder().encode(params.plaintext),
  })
  const payload = {
    seq: params.seq,
    deviceId: params.deviceId,
    docId: params.docId,
    authorKid: params.author.authorKid,
    keyGeneration: generation,
    data: enc.blobBase64Url,
    timestamp: FIXED_TIMESTAMP,
  }
  return protocol.createLogEntryJws({ payload, signingSeed: params.author.seed })
}

describe('DocLog (durable append-only log store)', () => {
  let log: DocLog

  beforeEach(() => {
    log = new DocLog(':memory:')
  })

  /** Convenience: append a real entry, returning its JWS + the disposition. */
  async function append(
    author: Author,
    docId: string,
    deviceId: string,
    seq: number,
    plaintext: string,
  ) {
    const jws = await makeEntryJws({ author, docId, deviceId, seq, plaintext })
    const result = log.appendEntry({
      docId,
      deviceId,
      seq,
      authorKid: author.authorKid,
      contentHash: await log.hashEntry(jws),
      entryJws: jws,
    })
    return { jws, result }
  }

  it('appends an entry and serves it via getSince with empty heads (cold reconstruction)', async () => {
    const author = await makeAuthor('a')
    const docId = randomUUID()
    const deviceId = randomUUID()
    const { jws, result } = await append(author, docId, deviceId, 0, 'hello')

    expect(result.disposition).toBe('accept-new-entry')
    expect(log.getSince(docId, {})).toEqual([jws])
    expect(log.getHeads(docId)).toEqual({ [deviceId]: 0 })
    expect(log.entryCount(docId)).toBe(1)
  })

  it('is idempotent on the same contentHash at the same (docId,deviceId,seq)', async () => {
    const author = await makeAuthor('a')
    const docId = randomUUID()
    const deviceId = randomUUID()
    const jws = await makeEntryJws({ author, docId, deviceId, seq: 0, plaintext: 'x' })
    const hash = await log.hashEntry(jws)

    const first = log.appendEntry({ docId, deviceId, seq: 0, authorKid: author.authorKid, contentHash: hash, entryJws: jws })
    const again = log.appendEntry({ docId, deviceId, seq: 0, authorKid: author.authorKid, contentHash: hash, entryJws: jws })

    expect(first.disposition).toBe('accept-new-entry')
    expect(again.disposition).toBe('idempotent-retransmission')
    expect(log.entryCount(docId)).toBe(1)
    expect(log.getSince(docId, {})).toEqual([jws])
  })

  it('rejects a divergent contentHash at the same coordinate and never overwrites the first entry', async () => {
    // The same author writes two different contents at (docId,deviceId,seq=0). The
    // second is a deterministic-nonce reuse hazard → reject-seq-collision inside
    // appendEntry (before store); the stored content is unchanged. INSERT OR IGNORE
    // on the PRIMARY KEY is an additional backstop.
    const author = await makeAuthor('a')
    const docId = randomUUID()
    const deviceId = randomUUID()
    const first = await makeEntryJws({ author, docId, deviceId, seq: 0, plaintext: 'first' })
    const second = await makeEntryJws({ author, docId, deviceId, seq: 0, plaintext: 'second' })
    const firstHash = await log.hashEntry(first)
    const secondHash = await log.hashEntry(second)
    expect(firstHash).not.toBe(secondHash)

    const r1 = log.appendEntry({ docId, deviceId, seq: 0, authorKid: author.authorKid, contentHash: firstHash, entryJws: first })
    const r2 = log.appendEntry({ docId, deviceId, seq: 0, authorKid: author.authorKid, contentHash: secondHash, entryJws: second })

    expect(r1.disposition).toBe('accept-new-entry')
    expect(r2.disposition).toBe('reject-seq-collision')
    expect(log.entryCount(docId)).toBe(1)
    expect(log.getContentHash(docId, deviceId, 0)).toBe(firstHash)
    expect(log.getSince(docId, {})).toEqual([first])
  })

  it('getSince returns only entries with seq > heads[deviceId], per device ascending', async () => {
    const author = await makeAuthor('a')
    const docId = randomUUID()
    const devA = randomUUID()
    const devB = randomUUID()

    const a0 = (await append(author, docId, devA, 0, 'a0')).jws
    const a1 = (await append(author, docId, devA, 1, 'a1')).jws
    const a2 = (await append(author, docId, devA, 2, 'a2')).jws
    const b0 = (await append(author, docId, devB, 0, 'b0')).jws

    // From scratch: all four.
    expect(new Set(log.getSince(docId, {}))).toEqual(new Set([a0, a1, a2, b0]))

    // With heads {devA:1}: only a2 and (devB absent → from 0) b0.
    const since = log.getSince(docId, { [devA]: 1 })
    expect(new Set(since)).toEqual(new Set([a2, b0]))

    expect(log.getHeads(docId)).toEqual({ [devA]: 2, [devB]: 0 })
  })

  it('supports limit + truncation deterministically', async () => {
    const author = await makeAuthor('a')
    const docId = randomUUID()
    const deviceId = randomUUID()
    const entries: string[] = []
    for (let seq = 0; seq < 5; seq += 1) {
      entries.push((await append(author, docId, deviceId, seq, `e${seq}`)).jws)
    }

    const page = log.getSinceWithTruncation(docId, {}, 2)
    expect(page.entries).toEqual([entries[0], entries[1]])
    expect(page.truncated).toBe(true)

    // Resume from heads {deviceId:1}: next two, still truncated.
    const page2 = log.getSinceWithTruncation(docId, { [deviceId]: 1 }, 2)
    expect(page2.entries).toEqual([entries[2], entries[3]])
    expect(page2.truncated).toBe(true)

    // Final page is not truncated.
    const page3 = log.getSinceWithTruncation(docId, { [deviceId]: 3 }, 2)
    expect(page3.entries).toEqual([entries[4]])
    expect(page3.truncated).toBe(false)
  })

  it('retains entries (never deletes — no delete after ACK)', async () => {
    // There is no delete API. After serving a catch-up page the entries remain,
    // so a second fresh client reconstructs identically.
    const author = await makeAuthor('a')
    const docId = randomUUID()
    const deviceId = randomUUID()
    const jws = (await append(author, docId, deviceId, 0, 'durable')).jws

    // Serve once.
    expect(log.getSince(docId, {})).toEqual([jws])
    // Serve again — still there.
    expect(log.getSince(docId, {})).toEqual([jws])
    expect(log.entryCount(docId)).toBe(1)
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(log))).not.toContain('delete')
  })

  it('reports stats (entriesByDoc, devicesByDoc, totalLogBytes, docCount)', async () => {
    const author = await makeAuthor('a')
    const docA = randomUUID()
    const docB = randomUUID()
    const devA = randomUUID()
    const devB = randomUUID()

    const e1 = (await append(author, docA, devA, 0, 'a')).jws
    const e2 = (await append(author, docA, devB, 0, 'b')).jws
    const e3 = (await append(author, docB, devA, 0, 'c')).jws

    expect(log.docCount()).toBe(2)
    expect(log.entryCount()).toBe(3)
    expect(log.entriesByDoc()).toEqual({ [docA]: 2, [docB]: 1 })
    expect(log.devicesByDoc()).toEqual({ [docA]: 2, [docB]: 1 })
    expect(log.totalLogBytes()).toBe(e1.length + e2.length + e3.length)
  })

  // --- VE-3a: deviceId ↔ authorKid binding (first-writer-wins) ----------------

  it('VE-3a: binds (docId,deviceId) to the first authorKid and lets that author keep writing', async () => {
    const alice = await makeAuthor('alice')
    const docId = randomUUID()
    const deviceId = randomUUID()

    expect((await append(alice, docId, deviceId, 0, 'a0')).result.disposition).toBe('accept-new-entry')
    expect(log.getAuthor(docId, deviceId)).toBe(alice.authorKid)
    // Same author, next seq → still accepted.
    expect((await append(alice, docId, deviceId, 1, 'a1')).result.disposition).toBe('accept-new-entry')
    expect(log.entryCount(docId)).toBe(2)
  })

  it('VE-3a: a DIFFERENT authorKid cannot write into a bound (docId,deviceId) namespace (squat guard)', async () => {
    const alice = await makeAuthor('alice')
    const mallory = await makeAuthor('mallory')
    const docId = randomUUID()
    const deviceId = randomUUID() // alice's device namespace

    const a0 = (await append(alice, docId, deviceId, 0, 'alice-0')).jws

    // mallory mints a genuinely mallory-signed entry (her authorKid) but claiming
    // alice's deviceId — both a new seq and alice's existing seq 0 are rejected.
    const m1 = await makeEntryJws({ author: mallory, docId, deviceId, seq: 1, plaintext: 'mallory-1' })
    const rejected1 = log.appendEntry({ docId, deviceId, seq: 1, authorKid: mallory.authorKid, contentHash: await log.hashEntry(m1), entryJws: m1 })
    expect(rejected1.disposition).toBe('reject-author-mismatch')

    const m0 = await makeEntryJws({ author: mallory, docId, deviceId, seq: 0, plaintext: 'mallory-0' })
    const rejected0 = log.appendEntry({ docId, deviceId, seq: 0, authorKid: mallory.authorKid, contentHash: await log.hashEntry(m0), entryJws: m0 })
    expect(rejected0.disposition).toBe('reject-author-mismatch')

    // Log unchanged: only alice's entry; owner still alice.
    expect(log.entryCount(docId)).toBe(1)
    expect(log.getSince(docId, {})).toEqual([a0])
    expect(log.getAuthor(docId, deviceId)).toBe(alice.authorKid)
  })

  it('VE-3a: first-write of a fresh (docId,deviceId) — exactly one author wins, the other is rejected (atomic)', async () => {
    // better-sqlite3 is synchronous and the binding lookup/insert + collision check
    // + append run in ONE appendEntry transaction with no intervening await, so two
    // first-writes for the same namespace cannot both bind: the first wins, the
    // second sees the owner and is rejected (no race window).
    const alice = await makeAuthor('alice')
    const bob = await makeAuthor('bob')
    const docId = randomUUID()
    const deviceId = randomUUID()

    const a0 = await makeEntryJws({ author: alice, docId, deviceId, seq: 0, plaintext: 'alice' })
    const b0 = await makeEntryJws({ author: bob, docId, deviceId, seq: 0, plaintext: 'bob' })
    const r1 = log.appendEntry({ docId, deviceId, seq: 0, authorKid: alice.authorKid, contentHash: await log.hashEntry(a0), entryJws: a0 })
    const r2 = log.appendEntry({ docId, deviceId, seq: 0, authorKid: bob.authorKid, contentHash: await log.hashEntry(b0), entryJws: b0 })

    expect(r1.disposition).toBe('accept-new-entry')
    expect(r2.disposition).toBe('reject-author-mismatch')
    expect(log.getAuthor(docId, deviceId)).toBe(alice.authorKid)
    expect(log.entryCount(docId)).toBe(1)
    expect(log.getSince(docId, {})).toEqual([a0])
  })

  it('shares one Database handle and does not close a borrowed connection', async () => {
    // The relay shares ONE better-sqlite3 connection between OfflineQueue and
    // DocLog; a borrowed handle must stay open after DocLog.close().
    const db = new Database(':memory:')
    const shared = new DocLog(db)
    const author = await makeAuthor('a')
    const docId = randomUUID()
    const deviceId = randomUUID()
    const jws = await makeEntryJws({ author, docId, deviceId, seq: 0, plaintext: 'shared' })
    shared.appendEntry({ docId, deviceId, seq: 0, authorKid: author.authorKid, contentHash: await shared.hashEntry(jws), entryJws: jws })

    shared.close() // no-op for a borrowed handle
    expect(db.open).toBe(true)
    db.close()
  })
})
