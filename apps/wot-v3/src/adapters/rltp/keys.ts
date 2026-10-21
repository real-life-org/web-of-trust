// The root IKM goes unchanged (64 bytes) into the library's key provider (architecture §5.1: the app
// derives nothing itself). session.ts calls this when it opens a holder after unlocking.
import { seedKeys, type KeyProvider } from '@real-life/trust-protocol'

export function keysFromRootIkm(rootIkm: Uint8Array): KeyProvider {
  if (rootIkm.length !== 64) throw new RangeError('root IKM must be the 64-byte BIP-39 seed')
  return seedKeys(rootIkm)
}
