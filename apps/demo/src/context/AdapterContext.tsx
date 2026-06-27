import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'
import {
  WebCryptoAdapter,
  OfflineFirstDiscoveryAdapter,
  OutboxMessagingAdapter,
  PersonalDocSpaceMetadataStorage,
} from '@web_of_trust/core/adapters'
import { WebSocketMessagingAdapter } from '@web_of_trust/core/adapters/messaging/websocket'
import {
  IndexedDBDocLogStore,
  IndexedDBKeyManagementAdapter,
  IndexedDBMemberUpdatePendingStore,
  IndexedDBMessageIdHistory,
} from '@web_of_trust/core/adapters/storage/indexeddb'
import { HttpDiscoveryAdapter } from '@web_of_trust/core/adapters/discovery/http'
import {
  CompactStorageManager,
  getMetrics,
} from '@web_of_trust/core/storage'
import type {
  CryptoAdapter,
  MessagingAdapter,
  Subscribable,
} from '@web_of_trust/core/ports'
import type {
  Attestation,
  AttestationMetadata,
  Contact,
  Identity,
  MessagingState,
  IdentitySession,
  Profile,
  PublicProfile,
} from '@web_of_trust/core/types'
import type { AutomergeReplicationAdapter } from '@web_of_trust/adapter-automerge'
import type { YjsReplicationAdapter } from '@web_of_trust/adapter-yjs'
import {
  ContactService,
  AttestationService,
  InboxReceptionHost,
} from '../services'
import { x25519MultibaseToPublicKeyBytes, encryptionKeyMultibaseFromDidDocument } from '@web_of_trust/core/protocol'
import { createProfileRecoveryWorkflow } from '@web_of_trust/core/application'
import { AutomergePublishStateStore } from '../adapters/AutomergePublishStateStore'
import { AutomergeGraphCacheStore } from '../adapters/AutomergeGraphCacheStore'
import { LocalCacheStore } from '../adapters/LocalCacheStore'
import { LocalOutboxStore } from '../adapters/LocalOutboxStore'
import { appRuntimeConfig, createHttpDiscoveryAdapter, protocolCrypto } from '../runtime/appRuntime'
import { LEGACY_DB_NAMES, deleteDatabase, wipeOrphanDurableStores } from '../services/durableStoreWipe'
import { useIdentity } from './IdentityContext'
import { splitAcceptedAttestations } from '../lib/publish-split'
// Yjs and Automerge adapters are dynamically imported to keep WASM out of the default bundle

const USE_YJS = import.meta.env.VITE_CRDT !== 'automerge'

interface DemoStoragePort {
  createIdentity(did: string, profile: Profile): Promise<Identity>
  getIdentity(): Promise<Identity | null>
  updateIdentity(identity: Identity): Promise<void>

  addContact(contact: Contact): Promise<void>
  getContacts(): Promise<Contact[]>
  getContact(did: string): Promise<Contact | null>
  updateContact(contact: Contact): Promise<void>
  removeContact(did: string): Promise<void>

  saveAttestation(attestation: Attestation): Promise<void>
  getReceivedAttestations(): Promise<Attestation[]>
  getAttestation(id: string): Promise<Attestation | null>

  getAttestationMetadata(attestationId: string): Promise<AttestationMetadata | null>
  setAttestationAccepted(attestationId: string, accepted: boolean): Promise<void>
}

interface DemoReactivePort {
  watchIdentity(): Subscribable<Identity | null>
  watchContacts(): Subscribable<Contact[]>
  watchAllAttestations(): Subscribable<Attestation[]>
  watchReceivedAttestations(): Subscribable<Attestation[]>
}

type DemoRuntimeStore = DemoStoragePort & DemoReactivePort & {
  setDeliveryStatus(attestationId: string, status: string): Promise<void>
  getAllDeliveryStatuses(): Promise<Map<string, string>>
}

interface AdapterContextValue {
  storage: DemoStoragePort
  reactiveStorage: DemoReactivePort
  crypto: CryptoAdapter
  messaging: MessagingAdapter
  discovery: OfflineFirstDiscoveryAdapter
  replication: AutomergeReplicationAdapter | YjsReplicationAdapter
  publishStateStore: AutomergePublishStateStore
  graphCacheStore: AutomergeGraphCacheStore
  outboxStore: LocalOutboxStore
  messagingState: MessagingState
  contactService: ContactService
  attestationService: AttestationService
  inboxReception: InboxReceptionHost
  syncDiscovery: () => Promise<void>
  flushOutbox: () => Promise<void>
  reconnectRelay: () => Promise<void>
  isInitialized: boolean
}

const AdapterContext = createContext<AdapterContextValue | null>(null)

interface AdapterProviderProps {
  children: ReactNode
  identity: IdentitySession
}

/**
 * AdapterProvider initializes the Personal Automerge Doc and all adapters.
 * The identity must be unlocked before this provider is rendered.
 */
export function AdapterProvider({ children, identity }: AdapterProviderProps) {
  const [isInitialized, setIsInitialized] = useState(false)
  const [initError, setInitError] = useState<string | null>(null)
  const [adapters, setAdapters] = useState<Omit<AdapterContextValue, 'isInitialized' | 'messagingState'> | null>(null)
  const [messagingState, setMessagingState] = useState<MessagingState>('disconnected')
  const { consumeInitialProfile } = useIdentity()

  useEffect(() => {
    let cancelled = false
    let outboxAdapter: OutboxMessagingAdapter | null = null
    let inboxReception: InboxReceptionHost | null = null
    let replicationAdapter: AutomergeReplicationAdapter | YjsReplicationAdapter | null = null
    let localCacheStore: LocalCacheStore | null = null
    let spaceCompactStore: CompactStorageManager | null = null
    let offlineHandler: (() => void) | null = null
    let unsubRemoteSync: (() => void) | null = null
    let durableStores: Array<{ close(): Promise<void> }> = []

    async function initAdapters() {
      try {
        getMetrics().setImpl(USE_YJS ? 'yjs' : 'compact-store')
        const t0 = performance.now()
        const lap = (label: string) => console.debug(`[init] ${label}: ${(performance.now() - t0).toFixed(0)}ms`)
        const did = identity.getDid()

        // Clean up old data when identity changes (or after logout where previousDid was cleared)
        const previousDid = localStorage.getItem('wot-active-did')
        if (!previousDid || previousDid !== did) {
          if (USE_YJS) {
            const { deleteYjsPersonalDocDB } = await import('@web_of_trust/adapter-yjs')
            await deleteYjsPersonalDocDB()
          } else {
            const { deletePersonalDocDB } = await import('@web_of_trust/adapter-automerge')
            await deletePersonalDocDB()
          }
          for (const dbName of LEGACY_DB_NAMES) await deleteDatabase(dbName)
        }
        // Durable Wiring fresh-start orphan cleanup (N0/N1/K1, no CompactStore
        // migration): on EVERY init, remove every DID-aware durable store + deviceId
        // key that does NOT belong to the current identity — the departing identity on
        // a switch AND any orphan left after a logout that cleared wot-active-did
        // (previousDid === null, the case the old previousDid-only branch missed). No
        // stale deviceId / key material / log survives under a different identity (else a
        // stale deviceId could re-enter a seq=0 nonce namespace, or dead keys linger).
        // The current identity's stores are KEPT (continuity; resolveConnectDeviceId
        // keeps them nonce-safe). Centralized in durableStoreWipe so reset / delete /
        // fresh-start cannot drift.
        await wipeOrphanDurableStores(did, previousDid)
        localStorage.setItem('wot-active-did', did)
        lap('identity-check')

        // Durable Wiring (N0): ONE store-resolved deviceId for BOTH the broker register
        // AND the log author. The durable log store owns the deviceId, resolved BEFORE
        // the messaging adapter is constructed (so the relay author-binding holds:
        // registered deviceId == log-author deviceId). resolveConnectDeviceId reconciles
        // any partial-store state (rotate-on-eviction / orphaned-log repair). DID-aware
        // DB names so an identity switch wipes them together with the log (N1/K1).
        const docLogStore = new IndexedDBDocLogStore(`wot-doc-log:${did}`)
        await docLogStore.init()
        const deviceId = await docLogStore.resolveConnectDeviceId()
        const keyManagement = new IndexedDBKeyManagementAdapter(`wot-key-management:${did}`)
        const memberUpdateStore = new IndexedDBMemberUpdatePendingStore(`wot-member-update-pending:${did}`)
        const messageIdHistory = new IndexedDBMessageIdHistory(`wot-message-id-history:${did}`)
        // Close these IndexedDB connections on unmount (identity switch) — see cleanup.
        durableStores = [docLogStore, keyManagement, memberUpdateStore, messageIdHistory]

        // VE-11 Trigger 2: a hard security detector (SeqCollisionError = nonce-reuse-
        // imminent / DeviceRevokedError) fired. Surface loudly; a richer UI halt /
        // re-auth banner is a follow-up.
        const onSecurityError = (error: Error): void => {
          console.error('[SECURITY] log-sync security detector fired:', error)
        }

        // Create WebSocket adapter — try to connect quickly, but don't block init
        const wsAdapter = new WebSocketMessagingAdapter(appRuntimeConfig.relayUrl, {
          deviceId,
          signBrokerAuthTranscript: (bytes: Uint8Array) => identity.signEd25519(bytes),
        })

        // Outbox + Inbox-Reception-Host VOR dem connect verdrahten: der Broker
        // liefert die Initial-Queue direkt nach der Auth aus — ohne
        // registrierten Host würde ein inbox/1.0 aus der Queue erst die
        // nächste Session erreichen (kein Verlust, aber unnötige Verzögerung).
        localCacheStore = new LocalCacheStore('wot-local-cache')
        await localCacheStore.open()
        const outboxStore = new LocalOutboxStore(localCacheStore)
        outboxAdapter = new OutboxMessagingAdapter(wsAdapter, outboxStore, {
          // content = Automerge CRDT sync messages (high volume, auto-resync on reconnect)
          // personal-sync = multi-device personal doc sync (same reason)
          // profile-update = fire-and-forget notifications
          skipTypes: ['content', 'profile-update', 'personal-sync'],
          sendTimeoutMs: 15_000,
        })

        // Inbox-Reception-Host (VE-9): besitzt inbox/1.0 inkl. ack/1.0-Ownership
        // (K1) — die Membership-Typen empfängt der Replication-Adapter selbst.
        inboxReception = new InboxReceptionHost({
          messaging: outboxAdapter,
          identity,
          crypto: protocolCrypto,
          // Durable Wiring (D1): durable inbox replay-protection so a reload cannot
          // be replayed (else the in-memory default forgets every processed id).
          messageIdHistory,
        })
        inboxReception.start()

        try {
          await Promise.race([
            wsAdapter.connect(did),
            new Promise((_, reject) => setTimeout(() => reject(new Error('WS connect timeout')), 3000)),
          ])
        } catch {
          console.warn('[init] WebSocket not connected yet, continuing with local data')
        }

        lap('ws-connect')
        // Initialize personal doc — loads from local IndexedDB first, syncs later via relay
        // Dynamic imports keep Automerge WASM (~2.6MB) out of the Yjs bundle
        let storage: DemoRuntimeStore
        if (USE_YJS) {
          const { initYjsPersonalDoc } = await import('@web_of_trust/adapter-yjs')
          await initYjsPersonalDoc(identity, wsAdapter, appRuntimeConfig.vaultUrl)
          console.debug('[init] Using Yjs PersonalDocManager')
          const { YjsStorageAdapter } = await import('../adapters/YjsStorageAdapter')
          storage = new YjsStorageAdapter(did)
        } else {
          const { isPersonalDocInitialized, initPersonalDoc } = await import('@web_of_trust/adapter-automerge')
          if (!isPersonalDocInitialized()) {
            await initPersonalDoc(identity, wsAdapter, appRuntimeConfig.vaultUrl)
          }
          console.debug('[init] Using Automerge PersonalDocManager')
          const { AutomergeStorageAdapter } = await import('../adapters/AutomergeStorageAdapter')
          storage = new AutomergeStorageAdapter(did)
        }
        lap('personal-doc-init')
        const crypto = new WebCryptoAdapter()
        let docFns: { getPersonalDoc: any; changePersonalDoc: any; onPersonalDocChange: any }
        if (USE_YJS) {
          const { getYjsPersonalDoc, changeYjsPersonalDoc, onYjsPersonalDocChange } = await import('@web_of_trust/adapter-yjs')
          docFns = {
            getPersonalDoc: getYjsPersonalDoc,
            changePersonalDoc: changeYjsPersonalDoc,
            onPersonalDocChange: onYjsPersonalDocChange,
          }
        } else {
          const { getPersonalDoc, changePersonalDoc, onPersonalDocChange } = await import('@web_of_trust/adapter-automerge')
          docFns = {
            getPersonalDoc,
            changePersonalDoc,
            onPersonalDocChange,
          }
        }
        const httpDiscovery = createHttpDiscoveryAdapter()

        lap('outbox-setup')
        const publishStateStore = new AutomergePublishStateStore(localCacheStore)
        const graphCacheStore = new AutomergeGraphCacheStore(localCacheStore)
        await Promise.all([publishStateStore.load(), graphCacheStore.load()])
        publishStateStore.setDid(did)
        const discovery = new OfflineFirstDiscoveryAdapter(httpDiscovery, publishStateStore, graphCacheStore)

        lap('discovery-setup')
        const attestationService = new AttestationService(storage)
        attestationService.setMessaging(outboxAdapter)
        attestationService.listenForReceipts(outboxAdapter)
        attestationService.setPersistDeliveryStatus((id, status) => storage.setDeliveryStatus(id, status))
        // K2-Versand (Sync 003): inbox/1.0 mit Inner-JWS + ECIES — der
        // Empfänger-Key kommt aus dem keyAgreement des DID-Dokuments (Sync 004).
        attestationService.configureDelivery({
          identity,
          resolveRecipientEncryptionKey: async (recipientDid) => {
            const result = await discovery.resolveProfile(recipientDid)
            const enc = encryptionKeyMultibaseFromDidDocument(result.didDocument)
            return enc ? x25519MultibaseToPublicKeyBytes(enc) : null
          },
        })

        // Restore persisted delivery statuses, then overlay outbox state
        const savedStatuses = await storage.getAllDeliveryStatuses()
        attestationService.restoreDeliveryStatuses(savedStatuses)
        attestationService.initFromOutbox(outboxStore)

        lap('attestation-service')
        const spaceMetadataStorage = new PersonalDocSpaceMetadataStorage(docFns)
        spaceCompactStore = new CompactStorageManager('wot-space-compact-store')
        await spaceCompactStore.open()
        if (USE_YJS) {
          const { YjsReplicationAdapter, flushYjsPersonalDoc, refreshYjsPersonalDocFromVault } = await import('@web_of_trust/adapter-yjs')
          replicationAdapter = new YjsReplicationAdapter({
            identity,
            messaging: outboxAdapter,
            keyManagement,
            memberUpdateStore,
            messageIdHistory,
            metadataStorage: spaceMetadataStorage,
            compactStore: spaceCompactStore,
            vaultUrl: appRuntimeConfig.vaultUrl,
            brokerUrls: [appRuntimeConfig.relayUrl],
            flushPersonalDoc: flushYjsPersonalDoc,
            refreshPersonalDocFromVault: refreshYjsPersonalDocFromVault,
            // Durable Wiring GATE-FLIP (the very last step): activate the durable
            // log-sync stack. docLogStore + the store-resolved deviceId give the relay
            // author-binding (N0); enableLogSync turns on the R/CG/A/SR/B log path. The
            // L1 gate also needs messaging.sendControlFrame, which OutboxMessagingAdapter
            // now forwards from the WebSocket adapter (VE-DW8).
            docLogStore,
            deviceId,
            enableLogSync: true,
            onSecurityError,
          })
        } else {
          const { AutomergeReplicationAdapter, SyncOnlyStorageAdapter } = await import('@web_of_trust/adapter-automerge')
          const spaceSyncStorage = new SyncOnlyStorageAdapter('wot-space-sync-states')
          replicationAdapter = new AutomergeReplicationAdapter({
            identity,
            messaging: outboxAdapter,
            keyManagement,
            memberUpdateStore,
            messageIdHistory,
            metadataStorage: spaceMetadataStorage,
            repoStorage: spaceSyncStorage,
            compactStore: spaceCompactStore,
            vaultUrl: appRuntimeConfig.vaultUrl,
            brokerUrls: [appRuntimeConfig.relayUrl],
            // Durable Wiring GATE-FLIP (mirror of the Yjs path).
            docLogStore,
            deviceId,
            enableLogSync: true,
            onSecurityError,
          })
        }

        // Ensure identity exists in personal doc.
        // If identity exists but has no name, restore from server (Evolu→Automerge migration).
        let existing = await storage.getIdentity()
        let needsInitialSync = false
        const needsRestore = !existing || !existing.profile.name
        console.log('[init] Identity check:', existing ? `found (name="${existing.profile.name}")` : 'not found', 'needsRestore:', needsRestore, 'DID:', did?.slice(0, 30))
        if (needsRestore && did) {
          const initialProfile = consumeInitialProfile()

          if (initialProfile) {
            // New onboarding — use the profile from onboarding flow
            console.log('[init] New onboarding profile:', initialProfile.name)
            if (existing) {
              await storage.updateIdentity({ ...existing, profile: initialProfile })
            } else {
              await storage.createIdentity(did, initialProfile)
            }
            if (initialProfile.name) {
              await publishStateStore.markDirty(did, 'profile')
              needsInitialSync = true
            }
          } else {
            // Recovery after Mnemonic-Import (Sync 004 Z.207-220): reconstruct
            // ONLY the public profile/discovery state via the application
            // workflow — the same `ProfileVersionCache` instance the resolve path
            // wrote (VE-5, else `version` reads back `undefined`). The classify
            // guard inside the workflow structurally forbids any private artifact.
            console.log('[restore] Attempting public-state recovery from wot-profiles server...')
            try {
              const recovery = createProfileRecoveryWorkflow({
                discovery: httpDiscovery,
                versionCache: httpDiscovery.getVersionCache(),
              })
              const result = await recovery.recoverPublicState(did)
              console.log('[restore] Recovered profile:', result.profile ? `name="${result.profile.value.name}"` : 'no profile')

              const restoredProfile = result.profile
                ? {
                    name: result.profile.value.name ?? '',
                    ...(result.profile.value.bio ? { bio: result.profile.value.bio } : {}),
                    ...(result.profile.value.avatar ? { avatar: result.profile.value.avatar } : {}),
                  }
                : { name: '' }

              if (existing) {
                await storage.updateIdentity({ ...existing, profile: restoredProfile, updatedAt: new Date().toISOString() })
              } else {
                await storage.createIdentity(did, restoredProfile)
              }

              const recoveredVerifications = result.verifications.value
              const recoveredAttestations = result.attestations.value
              console.log('[restore] Recovered /v:', recoveredVerifications.length, '/a:', recoveredAttestations.length)

              const contactTimestamps = new Map<string, string>()
              // The /v resource is disjointly filtered to verification-attestations
              // already (VE-2), so every item here is a verification by construction
              // — no claim-based discrimination needed.
              const recordVerificationPartner = (attestation: Attestation) => {
                if (attestation.from !== did && attestation.to !== did) return
                const contactDid = attestation.from === did ? attestation.to : attestation.from
                const current = contactTimestamps.get(contactDid)
                if (!current || attestation.createdAt < current) {
                  contactTimestamps.set(contactDid, attestation.createdAt)
                }
              }

              // Re-import recovered public artifacts with accepted:true (verhaltens-
              // gleich zum alten Restore — re-publish-fähig). /v + /a both imported.
              for (const attestation of [...recoveredVerifications, ...recoveredAttestations]) {
                await storage.saveAttestation(attestation)
                await storage.setAttestationAccepted(attestation.id, true)
              }
              for (const attestation of recoveredVerifications) {
                recordVerificationPartner(attestation)
              }

              // Demo runtime (PRIVATE state, NOT part of the workflow): peer-hop to
              // recover MY OWN outgoing verifications stored at the partner's /v, and
              // reconstruct the contact list. Verifications now live in /v, so the
              // peer-hop queries resolveVerifications (verhaltensgleich + /v).
              await Promise.all(Array.from(contactTimestamps.keys()).map(async (contactDid) => {
                const peerVerifications = await httpDiscovery.resolveVerifications(contactDid).catch((error) => {
                  console.warn('[restore] Failed to resolve peer verifications for contact:', contactDid, error)
                  return []
                })
                for (const attestation of peerVerifications) {
                  if (attestation.from === did && attestation.to === contactDid) {
                    const existingAtt = await storage.getAttestation(attestation.id)
                    if (!existingAtt) {
                      await storage.saveAttestation(attestation)
                    }
                    recordVerificationPartner(attestation)
                  }
                }
              }))

              for (const [contactDid, earliest] of contactTimestamps) {
                const existingContact = await storage.getContact(contactDid)
                if (!existingContact) {
                  await storage.addContact({
                    did: contactDid,
                    publicKey: '',
                    status: 'active',
                    verifiedAt: earliest,
                    createdAt: earliest,
                    updatedAt: earliest,
                  })
                }
              }

              console.log('[restore] Recovered public state:', restoredProfile.name || '(no name)')
              getMetrics().logLoad('wot-profiles', 0, 0)
            } catch (err) {
              console.warn('[restore] Could not recover from server (offline?):', err)
              // Fallback: create empty identity only if none exists
              if (!existing) {
                await storage.createIdentity(did, { name: '' })
              }
            }
          }
        }

        // syncDiscovery: retries all pending publish operations. The accepted set
        // is split disjointly by the WotVerification type marker (VE-2/VE-7), so
        // the dirty `/v` and `/a` resources are published with matching data —
        // identical split to the live uploadAttestations path.
        const syncDiscovery = async () => {
          try {
            await discovery.syncPending(did, identity, async () => {
              const localIdentity = await storage.getIdentity()
              const allAttestations = await storage.getReceivedAttestations()
              const accepted: Attestation[] = []
              for (const att of allAttestations) {
                const meta = await storage.getAttestationMetadata(att.id)
                if (meta?.accepted) accepted.push(att)
              }
              const { verifications, attestations } = await splitAcceptedAttestations(accepted, {
                crypto: protocolCrypto,
              })
              const updatedAt = new Date().toISOString()
              const result: {
                profile?: PublicProfile
                attestations?: { did: string; attestations: Attestation[]; updatedAt: string }
                verifications?: { did: string; verifications: Attestation[]; updatedAt: string }
              } = {}
              if (localIdentity) {
                result.profile = {
                  did,
                  name: localIdentity.profile.name,
                  ...(localIdentity.profile.bio ? { bio: localIdentity.profile.bio } : {}),
                  ...(localIdentity.profile.avatar ? { avatar: localIdentity.profile.avatar } : {}),
                  updatedAt,
                }
              }
              // Always include both lists — an EMPTY list is the valid new
              // public state after consent for the last verification/attestation
              // was revoked. syncPending only publishes the resources that are
              // actually dirty, so unconditionally providing the data never
              // causes spurious writes; it just lets a dirty /v or /a be
              // published with its (possibly empty) current contents. This
              // matches the primary uploadAttestations path, which also
              // publishes both lists unconditionally. (Codex review #198.)
              result.attestations = { did, attestations, updatedAt }
              result.verifications = { did, verifications, updatedAt }
              return result
            })
          } catch (error) {
            console.warn('Discovery sync failed:', error)
          }
        }

        const flushOutbox = async () => {
          try {
            await outboxAdapter!.flushOutbox()
          } catch (error) {
            console.warn('Outbox flush failed:', error)
          }
        }

        const metrics = getMetrics()

        const reconnectRelay = async () => {
          const currentState = outboxAdapter!.getState()
          if (!did || currentState === 'connected' || currentState === 'connecting') return
          try {
            setMessagingState('connecting')
            metrics.setRelayStatus(false, appRuntimeConfig.relayUrl, 0)
            await outboxAdapter!.connect(did)
            if (!cancelled) {
              setMessagingState('connected')
              metrics.setRelayStatus(true, appRuntimeConfig.relayUrl, wsAdapter.getPeerCount())
            }
          } catch (error) {
            console.warn('Relay reconnect failed:', error)
            if (!cancelled) {
              setMessagingState('error')
              metrics.setRelayStatus(false, appRuntimeConfig.relayUrl, 0)
            }
          }
        }

        if (!cancelled) {
          // Start replication adapter BEFORE setting initialized,
          // so spaces are loaded from IndexedDB before UI renders
          lap('before-replication-start')
          await replicationAdapter!.start()
          lap('after-replication-start')

          // Watch for remote personal doc sync (multi-device) — restore new spaces + sync
          unsubRemoteSync = docFns.onPersonalDocChange(() => {
            replicationAdapter?.requestSync('__all__').catch(() => {})
          })

          lap('ready')
          setAdapters({
            storage,
            reactiveStorage: storage,
            crypto,
            messaging: outboxAdapter,
            discovery,
            replication: replicationAdapter!,
            publishStateStore,
            graphCacheStore,
            outboxStore,
            contactService: new ContactService(storage),
            attestationService,
            inboxReception,
            syncDiscovery,
            flushOutbox,
            reconnectRelay,
          })
          setIsInitialized(true)

          // Connect to relay after adapters are set
          if (did && !cancelled) {
            // Track adapter state changes (disconnect, reconnect)
            outboxAdapter.onStateChange((state) => {
              if (!cancelled) {
                setMessagingState(state)
                metrics.setRelayStatus(state === 'connected', appRuntimeConfig.relayUrl, wsAdapter.getPeerCount())
                // Flush outbox + retry profile sync on reconnect
                if (state === 'connected') {
                  outboxAdapter!.flushOutbox()
                  syncDiscovery()
                }
              }
            })

            try {
              setMessagingState('connecting')
              metrics.setRelayStatus(false, appRuntimeConfig.relayUrl, 0)
              await outboxAdapter.connect(did)
              if (!cancelled) {
                setMessagingState('connected')
                metrics.setRelayStatus(true, appRuntimeConfig.relayUrl, wsAdapter.getPeerCount())
              }
              console.log(`Relay connected: ${appRuntimeConfig.relayUrl} (${did.slice(0, 20)}...)`)
            } catch (error) {
              console.warn('Relay connection failed:', error)
              if (!cancelled) {
                setMessagingState('error')
                metrics.setRelayStatus(false, appRuntimeConfig.relayUrl, 0)
              }
            }

            // Immediately disconnect WebSocket when browser goes offline
            offlineHandler = () => {
              if (!cancelled) {
                outboxAdapter!.disconnect()
                setMessagingState('disconnected')
                metrics.setRelayStatus(false, appRuntimeConfig.relayUrl, 0)
              }
            }
            window.addEventListener('offline', offlineHandler)

            // Note: Auto-reconnect is handled by OutboxMessagingAdapter (10s interval).
            // No additional timer needed here.
          }

          // After new identity creation, sync profile immediately.
          if (needsInitialSync && !cancelled) {
            setTimeout(() => { syncDiscovery() }, 500)
          }

        }
      } catch (error) {
        console.error('Failed to initialize adapters:', error)
        if (!cancelled) {
          const msg = error instanceof Error ? error.message : String(error)
          if (msg.includes('opfs') || msg.includes('storage') || msg.includes('access') || msg.includes('SecurityError')) {
            setInitError('storage-blocked')
          } else {
            setInitError(msg)
          }
        }
      }
    }

    initAdapters()
    return () => {
      cancelled = true
      if (offlineHandler) window.removeEventListener('offline', offlineHandler)
      if (unsubRemoteSync) unsubRemoteSync()
      replicationAdapter?.stop().catch(() => {})
      inboxReception?.stop()
      outboxAdapter?.disconnect()
      localCacheStore?.close()
      spaceCompactStore?.close()
      // Close the durable log-sync IndexedDB connections (no leak across identity switch).
      for (const store of durableStores) void store.close().catch(() => {})
    }
  }, [identity])

  if (initError) {
    const isStorageBlocked = initError === 'storage-blocked'
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-md text-center space-y-4">
          <div className="text-4xl">&#9888;&#65039;</div>
          <h2 className="text-xl font-semibold text-foreground">
            {isStorageBlocked ? 'Speicherzugriff blockiert' : 'Initialisierung fehlgeschlagen'}
          </h2>
          <p className="text-muted-foreground">
            {isStorageBlocked
              ? 'Die App benötigt Zugriff auf den lokalen Speicher, um deine Identität und Daten sicher auf deinem Gerät zu speichern. Bitte erlaube den Zugriff in den Browser-Einstellungen und lade die Seite neu.'
              : `Fehler: ${initError}`
            }
          </p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
          >
            Seite neu laden
          </button>
        </div>
      </div>
    )
  }

  if (!isInitialized || !adapters) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3">
        <div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" />
        <div className="text-sm text-muted-foreground">Initialisiere...</div>
      </div>
    )
  }

  return (
    <AdapterContext.Provider value={{ ...adapters, messagingState, isInitialized }}>
      {children}
    </AdapterContext.Provider>
  )
}

export function useAdapters(): AdapterContextValue {
  const context = useContext(AdapterContext)
  if (!context) {
    throw new Error('useAdapters must be used within an AdapterProvider')
  }
  return context
}

export function useOptionalAdapters(): AdapterContextValue | null {
  return useContext(AdapterContext)
}
