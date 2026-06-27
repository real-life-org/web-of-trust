/**
 * Restore/Clone mechanism for the Sync 002/003 log path (Slice A, P2-NIT-1,
 * VE-4/VE-5) — engine-neutral.
 *
 * The {@link LogSyncCoordinator} decides WHEN a restore-clone is needed (a
 * SEQ_COLLISION_DETECTED or a mid-session DEVICE_REVOKED on a SENT log-entry),
 * but the MECHANISM — mint a brand-new deviceId, device-revoke the old one,
 * re-register the new device — is an adapter/runtime concern. This module
 * encapsulates that mechanism as a {@link WriteRejectHandler} factory so the Yjs
 * Space path, the Yjs Personal-Doc path AND the Automerge adapter (Phase 4)
 * reuse the exact same restore/clone code. It depends ONLY on the Identity and
 * the MessagingAdapter (no CRDT engine), which is why it lives in wot-core
 * instead of per-adapter (DRY, single source of truth).
 *
 * Security invariant (Sync 002): a restore-clone produces a NEW deviceId, which
 * is a fresh per-(deviceId,docId) seq namespace starting at seq=0. The colliding
 * seq is therefore NEVER re-used with divergent plaintext (the deterministic
 * log-payload nonce binds (deviceId, seq), so a fresh deviceId can never collide
 * the old (key, nonce) pair).
 *
 * The full real-relay device re-registration (challenge-response handshake) is
 * P5/VE-11; here the device-revoke is sent (best-effort) and the new deviceId is
 * adopted, which is exactly what the InProcessLogBroker exercises.
 */
import type { MessagingAdapter, WireMessage } from '../../ports/MessagingAdapter'
import type { IdentitySession } from '../../types/identity-session'
import type { WriteReject, WriteRejectHandler } from '../../protocol/sync/log-sync-coordinator'
import { createBrokerDeviceRevokeControlFrame } from '../../protocol/sync/broker-device-revoke-control-frame'
import { createJcsEd25519JwsWithSigner } from '../../protocol/crypto/jws'

export interface RestoreCloneControllerConfig {
  identity: IdentitySession
  messaging: MessagingAdapter
  /**
   * Mint a fresh device UUID. Defaults to crypto.randomUUID(); injectable so a
   * test can assert a deterministic post-clone deviceId.
   */
  mintDeviceId?: () => string
  /**
   * Called after a restore-clone re-binds the active deviceId, so the adapter can
   * persist the new id (so a reload keeps the new namespace, not the revoked one).
   */
  onDeviceIdChanged?: (docId: string, newDeviceId: string, oldDeviceId: string) => void | Promise<void>
  now?: () => Date
}

/**
 * Build the {@link WriteRejectHandler} the LogSyncCoordinator calls on a
 * restore-clone / device-re-register disposition.
 *
 * - restore-clone: mint a new deviceId, send a `device-revoke` for the OLD one
 *   (Identity-Key-signed inner JWS), and return the new deviceId so the
 *   coordinator restarts the (deviceId,docId) log at seq=0.
 * - device-re-register: a DEVICE_NOT_REGISTERED keeps the same deviceId (the
 *   coordinator re-presents + resends); a DEVICE_ID_CONFLICT mints a fresh id.
 */
export function createRestoreCloneHandler(config: RestoreCloneControllerConfig): WriteRejectHandler {
  const mint = config.mintDeviceId ?? (() => crypto.randomUUID())
  const now = config.now ?? (() => new Date())

  return async (reject: WriteReject): Promise<{ deviceId: string } | void> => {
    if (reject.disposition === 'restore-clone') {
      const oldDeviceId = reject.deviceId
      const newDeviceId = mint()
      // device-revoke the OLD device (best-effort) on the CURRENT socket, BEFORE the
      // rebind tears it down: the relay invalidates the revoked device's scope so its
      // colliding seq can never be re-used.
      await sendDeviceRevoke(config, oldDeviceId, now).catch(() => {})
      // VE-11: persist the new deviceId FIRST (durable before it is registered/used),
      // so a crash between mint and rebind never re-adopts the old namespace on reload.
      // A persist failure propagates HARD (E1) — the coordinator's restore-clone aborts.
      await config.onDeviceIdChanged?.(reject.docId, newDeviceId, oldDeviceId)
      // VE-11: re-register the new deviceId on a FRESH socket and AWAIT `registered`
      // before returning, so the coordinator's write-pause gate opens only once writes
      // are accepted under the new id. Feature-detected: an in-process test broker that
      // needs no fresh-socket re-register simply omits rebindDeviceId.
      await rebindMessagingDeviceId(config.messaging, newDeviceId)
      return { deviceId: newDeviceId }
    }
    if (reject.disposition === 'device-re-register') {
      // DEVICE_ID_CONFLICT means our id clashes with another device — mint a fresh
      // one and re-register it. A plain DEVICE_NOT_REGISTERED keeps the id (the
      // coordinator re-presents + resends; the broker just had no record yet).
      if (reject.code === 'DEVICE_ID_CONFLICT') {
        const newDeviceId = mint()
        await config.onDeviceIdChanged?.(reject.docId, newDeviceId, reject.deviceId)
        await rebindMessagingDeviceId(config.messaging, newDeviceId)
        return { deviceId: newDeviceId }
      }
      return
    }
    return
  }
}

/** VE-11: re-register a new deviceId on a fresh socket, awaiting `registered`. No-op if unsupported. */
async function rebindMessagingDeviceId(messaging: MessagingAdapter, newDeviceId: string): Promise<void> {
  if (typeof messaging.rebindDeviceId === 'function') {
    await messaging.rebindDeviceId(newDeviceId)
  }
}

async function sendDeviceRevoke(
  config: RestoreCloneControllerConfig,
  deviceId: string,
  now: () => Date,
): Promise<void> {
  const messaging = config.messaging
  if (typeof messaging.sendControlFrame !== 'function') return
  const did = config.identity.getDid()
  // Inner JWS payload: the field-exact device-revoke claim (Sync 003), signed
  // with the Identity Key (kid = <did>#sig-0; the relay resolves the key from the
  // DID part). Operation-shaped signer — no raw seed exposed.
  const revocationJws = await createJcsEd25519JwsWithSigner(
    { alg: 'EdDSA', kid: `${did}#sig-0` },
    { type: 'device-revoke', did, deviceId, revokedAt: now().toISOString() },
    (input) => config.identity.signEd25519(input),
  )
  const frame = createBrokerDeviceRevokeControlFrame({ revocationJws })
  await messaging.sendControlFrame(frame as unknown as WireMessage & { type: string })
}
