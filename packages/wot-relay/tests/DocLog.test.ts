import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { DocLog } from '../src/log-store.js'
import { protocol, WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core'

// Slice R / Sync 002+003 durable-log store unit tests. Entries are REAL log-entry
// JWS (encryptLogPayload + createLogEntryJws over a raw-seed Ed25519 identity), and
// the broker content-hash is over the JCS-canonicalized payload (Sync 003 §Broker),
// so collision/dedup matches production.

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

/** Build a real log-entry: returns both the compact JWS and its payload object. */
async function makeEntry(params: {
  author: Author
  docId: string
  deviceId: string
  seq: number
  plaintext: string
  keyGeneration?: number
}): Promise<{ jws: string; payload: protocol.LogEntryPayload }> {
  const generation = params.keyGeneration ?? 0
  const spaceContentKey = await deriveKey(params.docId, generation)
  const enc = await protocol.encryptLogPayload({
    crypto,
    spaceContentKey,
    deviceId: params.deviceId,
    seq: params.seq,
    plaintext: new TextEncoder().encode(params.plaintext),
  })
  const payload: protocol.LogEntryPayload = {
    seq: params.seq,
    deviceId: params.deviceId,
    docId: params.docId,
    authorKid: params.author.authorKid,
    keyGeneration: generation,
    data: enc.blobBase64Url,
    timestamp: FIXED_TIMESTAMP,
  }
  const jws = await protocol.createLogEntryJws({ payload, signingSeed: params.author.seed })
  return { jws, payload }
}

describe('DocLog (durable append-only log store)', () => {
  let log: DocLog

  beforeEach(() => {
    log = new DocLog(':memory:')
  })

  /** Convenience: append a real entry (payload-hash per Sync 003), with its disposition. */
  async function append(
    author: Author,
    docId: string,
    deviceId: string,
    seq: number,
    plaintext: string,
  ) {
    const { jws, payload } = await makeEntry({ author, docId, deviceId, seq, plaintext })
    const result = log.appendEntry({
      docId,
      deviceId,
      seq,
      contentHash: await log.hashPayload(payload),
      entryJws: jws,
    })
    return { jws, payload, result }
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

  it('is idempotent on the same payload at the same (docId,deviceId,seq)', async () => {
    const author = await makeAuthor('a')
    const docId = randomUUID()
    const deviceId = randomUUID()
    const { jws, payload } = await makeEntry({ author, docId, deviceId, seq: 0, plaintext: 'x' })
    const hash = await log.hashPayload(payload)

    const first = log.appendEntry({ docId, deviceId, seq: 0, contentHash: hash, entryJws: jws })
    const again = log.appendEntry({ docId, deviceId, seq: 0, contentHash: hash, entryJws: jws })

    expect(first.disposition).toBe('accept-new-entry')
    expect(again.disposition).toBe('idempotent-retransmission')
    expect(log.entryCount(docId)).toBe(1)
    expect(log.getSince(docId, {})).toEqual([jws])
  })

  it('Sync 003: content-hash is over the canonical PAYLOAD, not the JWS envelope — same payload, different JWS → idempotent', async () => {
    // Two valid JWS of the SAME log-entry payload but DIFFERENT envelopes (one via
    // createLogEntryJws {alg,kid}, one with an extra header field). The broker
    // hashes the JCS-canonicalized payload, so both map to the same content-hash →
    // the second is an idempotent retransmission, NOT a false SEQ_COLLISION.
    const author = await makeAuthor('a')
    const docId = randomUUID()
    const deviceId = randomUUID()
    const { jws: jws1, payload } = await makeEntry({ author, docId, deviceId, seq: 0, plaintext: 'same-payload' })
    const jws2 = await protocol.createJcsEd25519Jws(
      { alg: 'EdDSA', kid: payload.authorKid, typ: 'JWT' },
      payload as unknown as protocol.JsonValue,
      author.seed,
    )
    expect(jws1).not.toBe(jws2) // different envelope, same payload
    const hash = await log.hashPayload(payload)

    const r1 = log.appendEntry({ docId, deviceId, seq: 0, contentHash: hash, entryJws: jws1 })
    const r2 = log.appendEntry({ docId, deviceId, seq: 0, contentHash: hash, entryJws: jws2 })
    expect(r1.disposition).toBe('accept-new-entry')
    expect(r2.disposition).toBe('idempotent-retransmission')
    expect(log.entryCount(docId)).toBe(1)
  })

  it('rejects a divergent payload at the same coordinate and never overwrites the first entry', async () => {
    // The same author writes two different contents at (docId,deviceId,seq=0). The
    // second is a deterministic-nonce reuse hazard → reject-seq-collision inside
    // appendEntry (before store); the stored content is unchanged. INSERT OR IGNORE
    // on the PRIMARY KEY is an additional backstop.
    const author = await makeAuthor('a')
    const docId = randomUUID()
    const deviceId = randomUUID()
    const a = await makeEntry({ author, docId, deviceId, seq: 0, plaintext: 'first' })
    const b = await makeEntry({ author, docId, deviceId, seq: 0, plaintext: 'second' })
    const firstHash = await log.hashPayload(a.payload)
    const secondHash = await log.hashPayload(b.payload)
    expect(firstHash).not.toBe(secondHash)

    const r1 = log.appendEntry({ docId, deviceId, seq: 0, contentHash: firstHash, entryJws: a.jws })
    const r2 = log.appendEntry({ docId, deviceId, seq: 0, contentHash: secondHash, entryJws: b.jws })

    expect(r1.disposition).toBe('accept-new-entry')
    expect(r2.disposition).toBe('reject-seq-collision')
    expect(log.entryCount(docId)).toBe(1)
    expect(log.getContentHash(docId, deviceId, 0)).toBe(firstHash)
    expect(log.getSince(docId, {})).toEqual([a.jws])
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

  // --- appendEntry no longer enforces author-binding (moved to device list) ---

  it('appendEntry does NOT enforce author-binding: a different authorKid at a different seq is accepted', async () => {
    // Author-binding is now anchored on the DURABLE device list in the relay
    // (didForDevice), NOT on a per-(docId,deviceId) first-writer-wins owner in this
    // store. So appendEntry only classifies seq-collisions: two different authors
    // writing DIFFERENT seqs of the same (docId,deviceId) both succeed here. (The
    // relay rejects the foreign author upstream via author-binding before it ever
    // reaches appendEntry.)
    const alice = await makeAuthor('alice')
    const bob = await makeAuthor('bob')
    const docId = randomUUID()
    const deviceId = randomUUID()

    expect((await append(alice, docId, deviceId, 0, 'a0')).result.disposition).toBe('accept-new-entry')
    expect((await append(bob, docId, deviceId, 1, 'b1')).result.disposition).toBe('accept-new-entry')
    expect(log.entryCount(docId)).toBe(2)
    // getAuthor is gone — author-binding is not a DocLog concern anymore.
    expect((log as unknown as Record<string, unknown>).getAuthor).toBeUndefined()
  })

  it('appendEntry still rejects a divergent content at an existing coordinate regardless of author', async () => {
    // A second author writing DIVERGENT content at alice's existing seq 0 is still
    // a deterministic-nonce reuse hazard → reject-seq-collision (the store-level
    // VE-3 guard is independent of author-binding).
    const alice = await makeAuthor('alice')
    const bob = await makeAuthor('bob')
    const docId = randomUUID()
    const deviceId = randomUUID()

    const a0 = (await append(alice, docId, deviceId, 0, 'alice-0')).jws
    const b0 = await makeEntry({ author: bob, docId, deviceId, seq: 0, plaintext: 'bob-0' })
    const r = log.appendEntry({ docId, deviceId, seq: 0, contentHash: await log.hashPayload(b0.payload), entryJws: b0.jws })
    expect(r.disposition).toBe('reject-seq-collision')
    expect(log.entryCount(docId)).toBe(1)
    expect(log.getSince(docId, {})).toEqual([a0])
  })

  // --- durable device list (VE-1, Sync 003 §Device-Liste im Broker) -----------

  it('registerDevice stores a new device active and reports isNewDevice; re-register of the same (did,deviceId) is not new', () => {
    const did = `did:key:z6Mk${'a'.repeat(40)}`
    const deviceId = randomUUID()

    const first = log.registerDevice(did, deviceId)
    expect(first).toEqual({ disposition: 'registered', isNewDevice: true })
    expect(log.isActive(did, deviceId)).toBe(true)
    expect(log.didForDevice(deviceId)).toBe(did)
    const rec = log.getDevice(deviceId)
    expect(rec?.status).toBe('active')
    expect(rec?.did).toBe(did)

    const again = log.registerDevice(did, deviceId)
    expect(again).toEqual({ disposition: 'registered', isNewDevice: false })
  })

  it('registerDevice rejects a deviceId already owned by another DID with device-id-conflict (globally unique)', () => {
    const didA = `did:key:z6Mk${'a'.repeat(40)}`
    const didB = `did:key:z6Mk${'b'.repeat(40)}`
    const deviceId = randomUUID()

    expect(log.registerDevice(didA, deviceId).disposition).toBe('registered')
    const conflict = log.registerDevice(didB, deviceId)
    expect(conflict).toEqual({ disposition: 'device-id-conflict' })
    // Ownership unchanged.
    expect(log.didForDevice(deviceId)).toBe(didA)
  })

  it('revokeDevice marks the device revoked; a revoked device for THIS DID re-registers as device-revoked', () => {
    const did = `did:key:z6Mk${'c'.repeat(40)}`
    const deviceId = randomUUID()
    const revokedAt = '2026-06-22T10:00:00Z'

    expect(log.registerDevice(did, deviceId).disposition).toBe('registered')
    expect(log.revokeDevice(did, deviceId, revokedAt)).toEqual({ disposition: 'revoked' })
    expect(log.isActive(did, deviceId)).toBe(false)
    const rec = log.getDevice(deviceId)
    expect(rec?.status).toBe('revoked')
    expect(rec?.revokedAt).toBe(revokedAt)

    // Re-registering the revoked device for THIS DID → DEVICE_REVOKED.
    expect(log.registerDevice(did, deviceId)).toEqual({ disposition: 'device-revoked' })
  })

  it('a revoked deviceId stays a global tombstone: another DID re-registering it still gets device-id-conflict', () => {
    const didA = `did:key:z6Mk${'d'.repeat(40)}`
    const didB = `did:key:z6Mk${'e'.repeat(40)}`
    const deviceId = randomUUID()

    log.registerDevice(didA, deviceId)
    log.revokeDevice(didA, deviceId, '2026-06-22T10:00:00Z')
    // didB cannot claim the revoked tombstone.
    expect(log.registerDevice(didB, deviceId)).toEqual({ disposition: 'device-id-conflict' })
  })

  it('revokeDevice is idempotent: a re-revoke keeps the first revokedAt authoritative', () => {
    const did = `did:key:z6Mk${'f'.repeat(40)}`
    const deviceId = randomUUID()

    log.registerDevice(did, deviceId)
    expect(log.revokeDevice(did, deviceId, '2026-06-22T10:00:00Z')).toEqual({ disposition: 'revoked' })
    expect(log.revokeDevice(did, deviceId, '2026-12-31T23:59:59Z')).toEqual({ disposition: 'already-revoked' })
    expect(log.getDevice(deviceId)?.revokedAt).toBe('2026-06-22T10:00:00Z')
  })

  it('a valid revocation for an UNKNOWN device is accepted as a tombstone (still globally reserved)', () => {
    const did = `did:key:z6Mk${'a'.repeat(20)}${'b'.repeat(20)}`
    const otherDid = `did:key:z6Mk${'c'.repeat(20)}${'d'.repeat(20)}`
    const deviceId = randomUUID()

    expect(log.revokeDevice(did, deviceId, '2026-06-22T10:00:00Z')).toEqual({ disposition: 'tombstoned' })
    const rec = log.getDevice(deviceId)
    expect(rec?.status).toBe('revoked')
    expect(rec?.did).toBe(did)
    // The unknown-device tombstone still reserves the deviceId globally.
    expect(log.registerDevice(otherDid, deviceId)).toEqual({ disposition: 'device-id-conflict' })
    // And blocks re-registration by its own DID.
    expect(log.registerDevice(did, deviceId)).toEqual({ disposition: 'device-revoked' })
  })

  it('isActive is true only for an exact active (did,deviceId) match', () => {
    const did = `did:key:z6Mk${'a'.repeat(40)}`
    const otherDid = `did:key:z6Mk${'b'.repeat(40)}`
    const deviceId = randomUUID()

    expect(log.isActive(did, deviceId)).toBe(false) // unregistered
    log.registerDevice(did, deviceId)
    expect(log.isActive(did, deviceId)).toBe(true)
    expect(log.isActive(otherDid, deviceId)).toBe(false) // wrong DID
  })

  // --- durable space registry (Sync 003 §Space-Registrierung) ---------------

  it('registerSpace binds a new space at generation 0 with its admin set (TOFU first-writer-wins)', () => {
    const spaceId = randomUUID()
    const verificationKey = 'base64url-vk-aaa'
    const adminA = `did:key:z6Mk${'a'.repeat(40)}`
    const adminB = `did:key:z6Mk${'b'.repeat(40)}`

    expect(log.isSpaceRegistered(spaceId)).toBe(false)
    expect(log.getSpace(spaceId)).toBeNull()
    expect(log.getSpaceAdmins(spaceId)).toEqual([])

    const result = log.registerSpace({ spaceId, verificationKey, adminDids: [adminB, adminA] })
    expect(result).toEqual({ disposition: 'registered' })
    expect(log.isSpaceRegistered(spaceId)).toBe(true)
    expect(log.getSpace(spaceId)).toEqual({ verificationKey, generation: 0 })
    // getSpaceAdmins is deterministic (ascending), independent of insert order.
    expect(log.getSpaceAdmins(spaceId)).toEqual([adminA, adminB])
  })

  it('registerSpace is idempotent on an IDENTICAL re-register (same key + same admin set, any order)', () => {
    const spaceId = randomUUID()
    const verificationKey = 'base64url-vk-bbb'
    const adminA = `did:key:z6Mk${'c'.repeat(40)}`
    const adminB = `did:key:z6Mk${'d'.repeat(40)}`

    expect(log.registerSpace({ spaceId, verificationKey, adminDids: [adminA, adminB] })).toEqual({
      disposition: 'registered',
    })
    // Same verificationKey, same admin SET but reversed order → idempotent recovery.
    expect(log.registerSpace({ spaceId, verificationKey, adminDids: [adminB, adminA] })).toEqual({
      disposition: 'idempotent',
    })
    // No mutation: still generation 0, same admins.
    expect(log.getSpace(spaceId)).toEqual({ verificationKey, generation: 0 })
    expect(log.getSpaceAdmins(spaceId)).toEqual([adminA, adminB])
  })

  it('registerSpace rejects a divergent verificationKey for an already-registered spaceId with conflict', () => {
    const spaceId = randomUUID()
    const adminA = `did:key:z6Mk${'e'.repeat(40)}`

    expect(
      log.registerSpace({ spaceId, verificationKey: 'vk-original', adminDids: [adminA] }),
    ).toEqual({ disposition: 'registered' })
    // Same admins, DIFFERENT key → conflict (first-writer-wins).
    expect(
      log.registerSpace({ spaceId, verificationKey: 'vk-DIFFERENT', adminDids: [adminA] }),
    ).toEqual({ disposition: 'conflict' })
    // Binding unchanged.
    expect(log.getSpace(spaceId)).toEqual({ verificationKey: 'vk-original', generation: 0 })
    expect(log.getSpaceAdmins(spaceId)).toEqual([adminA])
  })

  it('registerSpace rejects a divergent admin SET for an already-registered spaceId with conflict', () => {
    const spaceId = randomUUID()
    const verificationKey = 'vk-shared'
    const adminA = `did:key:z6Mk${'a'.repeat(40)}`
    const adminB = `did:key:z6Mk${'b'.repeat(40)}`
    const adminC = `did:key:z6Mk${'c'.repeat(40)}`

    expect(
      log.registerSpace({ spaceId, verificationKey, adminDids: [adminA, adminB] }),
    ).toEqual({ disposition: 'registered' })
    // Same key, DIFFERENT admin set (adminC added, adminB dropped) → conflict.
    expect(
      log.registerSpace({ spaceId, verificationKey, adminDids: [adminA, adminC] }),
    ).toEqual({ disposition: 'conflict' })
    // A subset is also a divergent set → conflict.
    expect(
      log.registerSpace({ spaceId, verificationKey, adminDids: [adminA] }),
    ).toEqual({ disposition: 'conflict' })
    // Original admin set untouched.
    expect(log.getSpaceAdmins(spaceId)).toEqual([adminA, adminB])
  })

  // --- B2: in-transaction generation gate is atomic with the durable append ----

  it('B2: a NEW stale-generation entry appended AFTER a rotateSpace is reject-key-generation-stale (race-closing in-txn gate), but an already-stored entry stays idempotent at the old generation', async () => {
    // The relay's pre-await fast-path gate can be bypassed by a rotateSpace that lands
    // between the pre-gate read and the durable insert. This drives appendEntry DIRECTLY
    // in the order race-ordering would produce: register gen0, append seq0@gen0 (ok),
    // rotateSpace→gen1, then append seq1@gen0 → MUST be rejected by the IN-TRANSACTION
    // gate (not stored). An idempotent re-append of the ALREADY-stored seq0@gen0 still
    // ACKs (dedup precedes the gate). Without the in-txn gate the stale seq1 would persist.
    const author = await makeAuthor('b2-author')
    const docId = randomUUID()
    const deviceId = randomUUID()

    // The space MUST be registered so getSpace returns a generation (the gate is a
    // no-op for an unregistered Personal-Doc).
    log.registerSpace({ spaceId: docId, verificationKey: 'vk-b2', adminDids: [author.did] })
    expect(log.getSpace(docId)).toEqual({ verificationKey: 'vk-b2', generation: 0 })

    // seq0 @ gen0 lands while the space is at generation 0.
    const e0 = await makeEntry({ author, docId, deviceId, seq: 0, plaintext: 'gen0-seq0', keyGeneration: 0 })
    const r0 = log.appendEntry({
      docId,
      deviceId,
      seq: 0,
      contentHash: await log.hashPayload(e0.payload),
      entryJws: e0.jws,
      keyGeneration: 0,
    })
    expect(r0.disposition).toBe('accept-new-entry')
    expect(log.entryCount(docId)).toBe(1)

    // A concurrent rotation advances the registry generation to 1.
    log.rotateSpace(docId, 'vk-b2-gen1', 1)
    expect(log.getSpace(docId)).toEqual({ verificationKey: 'vk-b2-gen1', generation: 1 })

    // A NEW stale-generation write (seq1 @ gen0) is the removed-member-after-rotation
    // hazard: the in-txn gate MUST reject it (not store, not relay).
    const e1 = await makeEntry({ author, docId, deviceId, seq: 1, plaintext: 'gen0-seq1', keyGeneration: 0 })
    const r1 = log.appendEntry({
      docId,
      deviceId,
      seq: 1,
      contentHash: await log.hashPayload(e1.payload),
      entryJws: e1.jws,
      keyGeneration: 0,
    })
    expect(r1.disposition).toBe('reject-key-generation-stale')
    expect(log.entryCount(docId)).toBe(1) // seq1 was NOT persisted
    expect(log.getSince(docId, {})).toEqual([e0.jws])

    // Dedup still wins for the ALREADY-stored seq0 @ gen0 even though the space is now
    // at generation 1: an identical retransmission ACKs (idempotent), it is NOT
    // mis-classified as stale.
    const r0again = log.appendEntry({
      docId,
      deviceId,
      seq: 0,
      contentHash: await log.hashPayload(e0.payload),
      entryJws: e0.jws,
      keyGeneration: 0,
    })
    expect(r0again.disposition).toBe('idempotent-retransmission')
    expect(log.entryCount(docId)).toBe(1)

    // A current-generation NEW write (seq1 @ gen1) is accepted (the gate only blocks
    // entries OLDER than the current generation).
    const e1gen1 = await makeEntry({ author, docId, deviceId, seq: 1, plaintext: 'gen1-seq1', keyGeneration: 1 })
    const r1gen1 = log.appendEntry({
      docId,
      deviceId,
      seq: 1,
      contentHash: await log.hashPayload(e1gen1.payload),
      entryJws: e1gen1.jws,
      keyGeneration: 1,
    })
    expect(r1gen1.disposition).toBe('accept-new-entry')
    expect(log.entryCount(docId)).toBe(2)
  })

  it('B2: the generation gate is a no-op for an UNREGISTERED docId (Personal-Doc) — an old keyGeneration is still accepted', async () => {
    // getSpace returns null for an unregistered docId, so the gate never fires there.
    const author = await makeAuthor('b2-personal')
    const docId = randomUUID() // never registerSpace'd
    const deviceId = randomUUID()
    const e = await makeEntry({ author, docId, deviceId, seq: 0, plaintext: 'personal', keyGeneration: 0 })
    const r = log.appendEntry({
      docId,
      deviceId,
      seq: 0,
      contentHash: await log.hashPayload(e.payload),
      entryJws: e.jws,
      keyGeneration: 0,
    })
    expect(r.disposition).toBe('accept-new-entry')
  })

  it('registerSpace keeps distinct spaceIds independent', () => {
    const spaceA = randomUUID()
    const spaceB = randomUUID()
    const admin = `did:key:z6Mk${'f'.repeat(40)}`

    log.registerSpace({ spaceId: spaceA, verificationKey: 'vk-a', adminDids: [admin] })
    log.registerSpace({ spaceId: spaceB, verificationKey: 'vk-b', adminDids: [admin] })

    expect(log.getSpace(spaceA)).toEqual({ verificationKey: 'vk-a', generation: 0 })
    expect(log.getSpace(spaceB)).toEqual({ verificationKey: 'vk-b', generation: 0 })
    expect(log.isSpaceRegistered(randomUUID())).toBe(false)
  })

  it('shares one Database handle and does not close a borrowed connection', async () => {
    // The relay shares ONE better-sqlite3 connection between OfflineQueue and
    // DocLog; a borrowed handle must stay open after DocLog.close().
    const db = new Database(':memory:')
    const shared = new DocLog(db)
    const author = await makeAuthor('a')
    const docId = randomUUID()
    const deviceId = randomUUID()
    const { jws, payload } = await makeEntry({ author, docId, deviceId, seq: 0, plaintext: 'shared' })
    shared.appendEntry({ docId, deviceId, seq: 0, contentHash: await shared.hashPayload(payload), entryJws: jws })

    shared.close() // no-op for a borrowed handle
    expect(db.open).toBe(true)
    db.close()
  })

  it('personal-doc owner registry (A2 Teil B): first-writer-wins claim, idempotent same-DID, conflict different-DID', async () => {
    const docId = randomUUID()
    const didA = (await makeAuthor('owner-a')).did
    const didB = (await makeAuthor('owner-b')).did

    expect(log.isPersonalDocOwned(docId)).toBe(false)
    expect(log.getPersonalDocOwner(docId)).toBeNull()

    // First claim wins (TOFU).
    expect(log.claimPersonalDocOwner(docId, didA)).toEqual({ disposition: 'claimed' })
    expect(log.getPersonalDocOwner(docId)).toBe(didA)
    expect(log.isPersonalDocOwned(docId)).toBe(true)

    // Same DID re-claims (reconnect / another device of the same identity) → idempotent.
    expect(log.claimPersonalDocOwner(docId, didA)).toEqual({ disposition: 'idempotent' })
    expect(log.getPersonalDocOwner(docId)).toBe(didA)

    // A DIFFERENT DID → conflict; owner stays didA (the foreign-leaked-docId attack).
    expect(log.claimPersonalDocOwner(docId, didB)).toEqual({ disposition: 'conflict' })
    expect(log.getPersonalDocOwner(docId)).toBe(didA)

    expect(log.personalDocOwnerCount()).toBe(1)
  })

  it('personal-doc owner binding is DURABLE (survives a fresh DocLog over the same connection)', async () => {
    const db = new Database(':memory:')
    const first = new DocLog(db)
    const docId = randomUUID()
    const did = (await makeAuthor('durable-owner')).did
    expect(first.claimPersonalDocOwner(docId, did)).toEqual({ disposition: 'claimed' })

    // A fresh DocLog over the SAME connection (relay restart shares the file/connection).
    const second = new DocLog(db)
    expect(second.getPersonalDocOwner(docId)).toBe(did)
    expect(second.isPersonalDocOwned(docId)).toBe(true)
    db.close()
  })

  it('registerSpace respects personal-doc ownership (A2 Teil B anti-escalation): foreign admin set rejected; owner upgrade clears the personal binding', async () => {
    const docId = randomUUID()
    const owner = (await makeAuthor('po-owner')).did
    const foreigner = (await makeAuthor('po-foreign')).did
    log.claimPersonalDocOwner(docId, owner)

    // A foreigner promoting the personal doc to a space (owner NOT among adminDids) is rejected
    // atomically — the docId stays personal and the owner binding is intact.
    expect(log.registerSpace({ spaceId: docId, verificationKey: 'vk-f', adminDids: [foreigner] })).toEqual({
      disposition: 'personal-owner-conflict',
    })
    expect(log.isSpaceRegistered(docId)).toBe(false)
    expect(log.getPersonalDocOwner(docId)).toBe(owner)

    // The OWNER upgrading their own doc (their DID ∈ adminDids) → registered, and the personal
    // binding is cleared so the docId is never simultaneously space-registered AND personal-owned.
    expect(log.registerSpace({ spaceId: docId, verificationKey: 'vk-o', adminDids: [owner] })).toEqual({
      disposition: 'registered',
    })
    expect(log.isSpaceRegistered(docId)).toBe(true)
    expect(log.isPersonalDocOwned(docId)).toBe(false)
  })
})
