import type { KeyManagementPort } from '../../ports/key-management'

/**
 * InMemoryKeyManagementAdapter — default in-memory KeyManagementPort, analogous
 * to WebCryptoProtocolCryptoAdapter as the default ProtocolCryptoAdapter. No
 * durable persistence (that is the follow-up 1.B.3-key-rotation-pending-buffer
 * sub-slice, Sync 002 Z.171).
 */

interface SpaceKeyState {
  // index = generation; null = gap placeholder (never a real key)
  keys: (Uint8Array | null)[]
}

const PLACEHOLDER: null = null

function assertValidGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error('Key generation must be a non-negative safe integer')
  }
}

function copyKey(key: Uint8Array): Uint8Array {
  // Defensive copy: callers must not be able to mutate internal storage through
  // a returned reference, and a saved key must not change if the caller mutates
  // its input afterwards.
  return new Uint8Array(key)
}

export class InMemoryKeyManagementAdapter implements KeyManagementPort {
  private spaces = new Map<string, SpaceKeyState>()

  async saveKey(spaceId: string, generation: number, key: Uint8Array): Promise<void> {
    assertValidGeneration(generation)
    if (key.length !== 32) throw new Error('Space content key must be 32 bytes')
    let state = this.spaces.get(spaceId)
    if (!state) {
      state = { keys: [] }
      this.spaces.set(spaceId, state)
    }
    while (state.keys.length <= generation) state.keys.push(PLACEHOLDER)
    state.keys[generation] = copyKey(key)
  }

  async getCurrentKey(spaceId: string): Promise<Uint8Array | null> {
    const state = this.spaces.get(spaceId)
    if (!state || state.keys.length === 0) return null
    const latest = state.keys[state.keys.length - 1]
    return latest === null ? null : copyKey(latest)
  }

  async getCurrentGeneration(spaceId: string): Promise<number> {
    const state = this.spaces.get(spaceId)
    if (!state) return -1
    return state.keys.length - 1
  }

  async getKeyByGeneration(spaceId: string, generation: number): Promise<Uint8Array | null> {
    assertValidGeneration(generation)
    const state = this.spaces.get(spaceId)
    if (!state || generation >= state.keys.length) return null
    const key = state.keys[generation]
    return key === null ? null : copyKey(key)
  }
}
