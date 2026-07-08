import { describe, expect, it, vi } from 'vitest'
import { restoreFromVault } from '../src/PersonalDocManager'
import type { VaultClient } from '@web_of_trust/core/adapters'

// DATENSICHERHEIT (spec-startup-local-first, TEIL A / Blocker 3):
// PersonalDocManager.restoreFromVault() used to catch EVERY error — including a
// network/HTTP failure — as "decrypt failed" and then vault.deleteDoc(). With the
// new VaultClient timeout backstop a dead-but-reachable box surfaces as an
// AbortError; treating that as corruption would IRREVERSIBLY DELETE an intact
// snapshot = data loss. The fix catches fetch failures BEFORE the
// decrypt-corruption branch: restore nothing, delete nothing. ONLY a
// genuinely-fetched-but-undecryptable snapshot is deleted.

const KEY = new Uint8Array(32).fill(7)
const VAULT_DOC_ID = 'personal-doc'

function vaultDouble(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getChanges: vi.fn(),
    deleteDoc: vi.fn().mockResolvedValue(undefined),
    pushChange: vi.fn(),
    putSnapshot: vi.fn(),
    getDocInfo: vi.fn(),
    ...overrides,
  } as unknown as VaultClient & { getChanges: ReturnType<typeof vi.fn>; deleteDoc: ReturnType<typeof vi.fn> }
}

describe('PersonalDocManager.restoreFromVault — timeout/network never deletes (Blocker 3)', () => {
  it('does NOT deleteDoc when getChanges times out (AbortError)', async () => {
    const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    const vault = vaultDouble({ getChanges: vi.fn().mockRejectedValue(abortErr) })

    const result = await restoreFromVault(vault, KEY)

    expect(result).toBeNull()
    expect(vault.deleteDoc).not.toHaveBeenCalled()
  })

  it('does NOT deleteDoc on a generic network / HTTP failure', async () => {
    const vault = vaultDouble({ getChanges: vi.fn().mockRejectedValue(new Error('Vault getChanges failed: 502')) })

    const result = await restoreFromVault(vault, KEY)

    expect(result).toBeNull()
    expect(vault.deleteDoc).not.toHaveBeenCalled()
  })

  it('does NOT deleteDoc when the vault simply has no snapshot', async () => {
    const vault = vaultDouble({
      getChanges: vi.fn().mockResolvedValue({ docId: VAULT_DOC_ID, snapshot: null, changes: [] }),
    })

    const result = await restoreFromVault(vault, KEY)

    expect(result).toBeNull()
    expect(vault.deleteDoc).not.toHaveBeenCalled()
  })

  it('DOES deleteDoc for a genuinely undecryptable (corrupt) snapshot', async () => {
    // A well-formed packed blob [nonceLen=12][12-byte nonce][ciphertext] whose
    // ciphertext is random → AES-GCM tag verification fails → OperationError. This
    // is the ONLY case where deletion is correct (irrecoverable, deterministic key).
    const packed = new Uint8Array(1 + 12 + 40)
    packed[0] = 12
    for (let i = 1; i < packed.length; i++) packed[i] = (i * 37) % 256
    const corruptBase64 = Buffer.from(packed).toString('base64')

    const vault = vaultDouble({
      getChanges: vi.fn().mockResolvedValue({
        docId: VAULT_DOC_ID,
        snapshot: { data: corruptBase64, upToSeq: 3 },
        changes: [],
      }),
    })

    const result = await restoreFromVault(vault, KEY)

    expect(result).toBeNull()
    // Deletion IS correct here (irrecoverable ciphertext, deterministic key) — it
    // targets the same personal-doc id the read used.
    expect(vault.deleteDoc).toHaveBeenCalledOnce()
    expect(vault.deleteDoc).toHaveBeenCalledWith(vault.getChanges.mock.calls[0][0])
  })
})
