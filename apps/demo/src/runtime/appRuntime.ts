import {
  AttestationWorkflow,
  IdentityWorkflow,
  VerificationWorkflow,
} from '@web_of_trust/core/application'
import { HttpDiscoveryAdapter } from '@web_of_trust/core/adapters/discovery/http'
import { FallbackDiscoveryAdapter } from '@web_of_trust/core/adapters'
import { IndexedDbIdentitySeedVault } from '@web_of_trust/core/adapters/storage/indexeddb'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import type { VersionedDiscoveryAdapter } from '@web_of_trust/core/ports'

export const appRuntimeConfig = {
  relayUrl: import.meta.env.VITE_RELAY_URL ?? 'wss://relay.web-of-trust.de',
  profileServiceUrl: import.meta.env.VITE_PROFILE_SERVICE_URL ?? 'https://profiles.web-of-trust.de',
  vaultUrl: import.meta.env.VITE_VAULT_URL ?? 'https://vault.web-of-trust.de',
  // Stage A dual-broker (Sync 003 §Broker-Zuordnung und Multi-Broker): optional
  // SECONDARY backend. When set, the inbox family fans out to both brokers and
  // vault pushes go to both vaults — handshakes and recovery work wherever ANY
  // connectivity exists (festival box + public server). Unset ⇒ exactly today's
  // single-broker behaviour (I-SINGLE-OFF).
  relayUrl2: import.meta.env.VITE_RELAY_URL_2 as string | undefined,
  vaultUrl2: import.meta.env.VITE_VAULT_URL_2 as string | undefined,
  // Stage A.2 discovery-dual: optional SECONDARY profile server. When set, profile
  // resolves fall back primary→secondary and publishes fan out to both (box +
  // public server). Unset ⇒ exactly today's single-server behaviour (I-SINGLE-OFF).
  profileServiceUrl2: import.meta.env.VITE_PROFILE_SERVICE_URL_2 as string | undefined,
}

// Eine ProtocolCryptoAdapter-Instanz für die ganze App — auch der
// Inbox-Reception-Host und die Attestation-Zustellung (Sync 003) nutzen sie.
export const protocolCrypto = new WebCryptoProtocolCryptoAdapter()

export const verificationWorkflow = new VerificationWorkflow({
  crypto: protocolCrypto,
})

// ONE shared seed vault for the whole app: `wot-identity` is single-seed per origin, so a
// single connection suffices. A fresh vault per createIdentityWorkflow() call would each open
// + register (in the module-level wipe registry) a connection that nothing closes outside the
// full-wipe path — an unbounded handle/memory leak over a long single-page session. The shared
// instance keeps that registry size-1; the full-wipe path closes it via
// closeOpenIdentitySeedVaultConnections() and the next operation transparently reopens it.
const identitySeedVault = new IndexedDbIdentitySeedVault()

export function createIdentityWorkflow(): IdentityWorkflow {
  return new IdentityWorkflow({
    crypto: protocolCrypto,
    vault: identitySeedVault,
  })
}

export function createAttestationWorkflow(): AttestationWorkflow {
  return new AttestationWorkflow({ crypto: protocolCrypto })
}

/**
 * The discovery adapter every consumer wraps/uses (OfflineFirstDiscoveryAdapter,
 * the recovery workflow via getVersionCache, and the PublicProfile page). With
 * VITE_PROFILE_SERVICE_URL_2 set it is a FallbackDiscoveryAdapter over
 * [primary, secondary]; unset ⇒ the raw primary HttpDiscoveryAdapter, so the
 * single-server path stays byte-identical (I-SINGLE-OFF).
 */
export function createHttpDiscoveryAdapter(): VersionedDiscoveryAdapter {
  const primary = new HttpDiscoveryAdapter(appRuntimeConfig.profileServiceUrl)
  if (!appRuntimeConfig.profileServiceUrl2) return primary
  // Secondary target: pass adoptLegacyCacheKeys:false so it starts with an empty,
  // non-adopting version namespace — the pre-namespace baseline belongs to the
  // primary (Codex R1 point 4).
  const secondary = new HttpDiscoveryAdapter(
    appRuntimeConfig.profileServiceUrl2,
    undefined,
    undefined,
    undefined,
    undefined,
    { adoptLegacyCacheKeys: false },
  )
  return new FallbackDiscoveryAdapter([primary, secondary], {
    targetKeys: [appRuntimeConfig.profileServiceUrl, appRuntimeConfig.profileServiceUrl2],
  })
}

// Browser-local stable deviceId source for Sync 003 broker auth. Scoped per
// DID so two identities on the same browser register as distinct devices.
// `crypto.randomUUID()` emits canonical lowercase UUID-v4. This source defines
// no protocol semantics — it only persists the value the broker accepts.
const DEVICE_ID_STORAGE_PREFIX = 'wot-device-id:'

export function getOrCreateBrowserDeviceId(did: string): string {
  const key = `${DEVICE_ID_STORAGE_PREFIX}${did}`
  const existing = localStorage.getItem(key)
  if (existing && isCanonicalLowercaseUuidV4(existing)) return existing
  const id = crypto.randomUUID()
  localStorage.setItem(key, id)
  return id
}

function isCanonicalLowercaseUuidV4(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
}
