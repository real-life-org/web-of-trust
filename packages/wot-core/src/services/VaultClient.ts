/**
 * VaultClient — HTTP client for the wot-vault encrypted document store.
 *
 * The vault stores encrypted Automerge changes/snapshots for offline multi-device sync.
 * All data is opaque ciphertext — the vault never decrypts anything.
 *
 * Auth: JWS identity token + signed capability per request.
 */
import { createCapability } from '../crypto/capabilities'
import { createResourceRef } from '../types/resource-ref'
import type { WotIdentity } from '../identity/WotIdentity'
import { getTraceLog } from '../storage/TraceLog'

export interface VaultChange {
  seq: number
  data: string // base64
  authorDid: string
  createdAt: string
}

export interface VaultSnapshot {
  data: string // base64
  upToSeq: number
}

export interface VaultDocInfo {
  latestSeq: number
  snapshotSeq: number | null
  changeCount: number
}

export interface VaultChangesResponse {
  docId: string
  snapshot: VaultSnapshot | null
  changes: VaultChange[]
}

export class VaultClient {
  private vaultUrl: string
  private identity: WotIdentity
  /** Cache capabilities per docId (valid for 1 hour) */
  private capabilityCache = new Map<string, { jws: string; expiresAt: number }>()

  constructor(vaultUrl: string, identity: WotIdentity) {
    this.vaultUrl = vaultUrl.replace(/\/$/, '')
    this.identity = identity
  }

  /**
   * Push an encrypted change to the vault.
   * @returns The assigned sequence number.
   */
  async pushChange(docId: string, encryptedData: Uint8Array): Promise<number> {
    const trace = getTraceLog()
    const start = performance.now()
    try {
      const headers = await this.authHeaders(docId, ['read', 'write'])
      const res = await fetch(`${this.vaultUrl}/docs/${encodeURIComponent(docId)}/changes`, {
        method: 'POST',
        headers,
        body: encryptedData,
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`Vault pushChange failed: ${res.status} ${body}`)
      }
      const json = await res.json()
      trace.log({ store: 'vault', operation: 'write', label: `pushChange ${docId.slice(0, 12)}…`, durationMs: Math.round(performance.now() - start), sizeBytes: encryptedData.byteLength, success: true, meta: { docId, seq: json.seq } })
      return json.seq as number
    } catch (err) {
      trace.log({ store: 'vault', operation: 'write', label: `pushChange ${docId.slice(0, 12)}…`, durationMs: Math.round(performance.now() - start), sizeBytes: encryptedData.byteLength, success: false, error: err instanceof Error ? err.message : String(err), meta: { docId } })
      throw err
    }
  }

  /**
   * Get all changes (and optional snapshot) for a document.
   */
  async getChanges(docId: string, since = 0): Promise<VaultChangesResponse> {
    const trace = getTraceLog()
    const start = performance.now()
    try {
      const headers = await this.authHeaders(docId, ['read'])
      const url = `${this.vaultUrl}/docs/${encodeURIComponent(docId)}/changes${since > 0 ? `?since=${since}` : ''}`
      const res = await fetch(url, { headers })
      if (res.status === 404) {
        trace.log({ store: 'vault', operation: 'read', label: `getChanges ${docId.slice(0, 12)}… (not found)`, durationMs: Math.round(performance.now() - start), success: true, meta: { docId, since, changes: 0 } })
        return { docId, snapshot: null, changes: [] }
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`Vault getChanges failed: ${res.status} ${body}`)
      }
      const data = await res.json()
      trace.log({ store: 'vault', operation: 'read', label: `getChanges ${docId.slice(0, 12)}…`, durationMs: Math.round(performance.now() - start), success: true, meta: { docId, since, changes: data.changes?.length ?? 0, hasSnapshot: !!data.snapshot } })
      return data
    } catch (err) {
      trace.log({ store: 'vault', operation: 'read', label: `getChanges ${docId.slice(0, 12)}…`, durationMs: Math.round(performance.now() - start), success: false, error: err instanceof Error ? err.message : String(err), meta: { docId, since } })
      throw err
    }
  }

  /**
   * Store a compacted snapshot (replaces changes up to upToSeq).
   */
  async putSnapshot(docId: string, encryptedData: Uint8Array, nonce: Uint8Array, upToSeq: number): Promise<void> {
    const trace = getTraceLog()
    const start = performance.now()
    const totalSize = 1 + nonce.length + encryptedData.length
    try {
      const headers = await this.authHeaders(docId, ['read', 'write'])
      headers['Content-Type'] = 'application/json'

      const packed = new Uint8Array(totalSize)
      packed[0] = nonce.length
      packed.set(nonce, 1)
      packed.set(encryptedData, 1 + nonce.length)

      const res = await fetch(`${this.vaultUrl}/docs/${encodeURIComponent(docId)}/snapshot`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          data: uint8ToBase64(packed),
          upToSeq,
        }),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`Vault putSnapshot failed: ${res.status} ${body}`)
      }
      trace.log({ store: 'vault', operation: 'write', label: `putSnapshot ${docId.slice(0, 12)}…`, durationMs: Math.round(performance.now() - start), sizeBytes: totalSize, success: true, meta: { docId, upToSeq } })
    } catch (err) {
      trace.log({ store: 'vault', operation: 'write', label: `putSnapshot ${docId.slice(0, 12)}…`, durationMs: Math.round(performance.now() - start), sizeBytes: totalSize, success: false, error: err instanceof Error ? err.message : String(err), meta: { docId, upToSeq } })
      throw err
    }
  }

  /**
   * Get document info (seq, change count).
   */
  async getDocInfo(docId: string): Promise<VaultDocInfo | null> {
    const trace = getTraceLog()
    const start = performance.now()
    try {
      const headers = await this.authHeaders(docId, ['read'])
      const res = await fetch(`${this.vaultUrl}/docs/${encodeURIComponent(docId)}/info`, { headers })
      if (res.status === 404) {
        trace.log({ store: 'vault', operation: 'read', label: `getDocInfo ${docId.slice(0, 12)}… (not found)`, durationMs: Math.round(performance.now() - start), success: true, meta: { docId } })
        return null
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`Vault getDocInfo failed: ${res.status} ${body}`)
      }
      const info = await res.json()
      trace.log({ store: 'vault', operation: 'read', label: `getDocInfo ${docId.slice(0, 12)}…`, durationMs: Math.round(performance.now() - start), success: true, meta: { docId, ...info } })
      return info
    } catch (err) {
      trace.log({ store: 'vault', operation: 'read', label: `getDocInfo ${docId.slice(0, 12)}…`, durationMs: Math.round(performance.now() - start), success: false, error: err instanceof Error ? err.message : String(err), meta: { docId } })
      throw err
    }
  }

  /**
   * Delete a document from the vault.
   */
  async deleteDoc(docId: string): Promise<void> {
    const trace = getTraceLog()
    const start = performance.now()
    try {
      const headers = await this.authHeaders(docId, ['read', 'write', 'delete'])
      const res = await fetch(`${this.vaultUrl}/docs/${encodeURIComponent(docId)}`, {
        method: 'DELETE',
        headers,
      })
      if (!res.ok && res.status !== 404) {
        const body = await res.text().catch(() => '')
        throw new Error(`Vault deleteDoc failed: ${res.status} ${body}`)
      }
      trace.log({ store: 'vault', operation: 'delete', label: `deleteDoc ${docId.slice(0, 12)}…`, durationMs: Math.round(performance.now() - start), success: true, meta: { docId } })
    } catch (err) {
      trace.log({ store: 'vault', operation: 'delete', label: `deleteDoc ${docId.slice(0, 12)}…`, durationMs: Math.round(performance.now() - start), success: false, error: err instanceof Error ? err.message : String(err), meta: { docId } })
      throw err
    }
  }

  // --- Auth ---

  private async authHeaders(docId: string, permissions: string[]): Promise<Record<string, string>> {
    const token = await this.identity.signJws({
      did: this.identity.getDid(),
      iat: Math.floor(Date.now() / 1000),
    })

    const capability = await this.getOrCreateCapability(docId, permissions)

    return {
      'Authorization': `Bearer ${token}`,
      'X-Capability': capability,
    }
  }

  private async getOrCreateCapability(docId: string, permissions: string[]): Promise<string> {
    const cacheKey = `${docId}:${permissions.sort().join(',')}`
    const cached = this.capabilityCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.jws
    }

    const expiration = new Date(Date.now() + 60 * 60 * 1000).toISOString() // 1 hour
    const capability = await createCapability(
      {
        issuer: this.identity.getDid(),
        audience: this.identity.getDid(),
        resource: createResourceRef('space', docId),
        permissions: permissions as any[],
        expiration,
      },
      (payload) => this.identity.signJws(payload),
    )

    this.capabilityCache.set(cacheKey, {
      jws: capability,
      expiresAt: Date.now() + 55 * 60 * 1000, // Refresh 5 min before expiry
    })

    return capability
  }
}

// --- Helpers ---

function uint8ToBase64(data: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i])
  }
  return btoa(binary)
}

export function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
