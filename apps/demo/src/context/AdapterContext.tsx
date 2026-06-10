import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'
import {
  WebCryptoAdapter,
  OfflineFirstDiscoveryAdapter,
  OutboxMessagingAdapter,
  PersonalDocSpaceMetadataStorage,
  InMemoryKeyManagementAdapter,
} from '@web_of_trust/core/adapters'
import { WebSocketMessagingAdapter } from '@web_of_trust/core/adapters/messaging/websocket'
import { HttpDiscoveryAdapter } from '@web_of_trust/core/adapters/discovery/http'
import {
  CompactStorageManager,
  getMetrics,
} from '@web_of_trust/core/storage'
import type {
  CryptoAdapter,
  MessagingAdapter,
  PublicAttestationsData,
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
} from '../services'
import { AutomergePublishStateStore } from '../adapters/AutomergePublishStateStore'
import { AutomergeGraphCacheStore } from '../adapters/AutomergeGraphCacheStore'
import { LocalCacheStore } from '../adapters/LocalCacheStore'
import { LocalOutboxStore } from '../adapters/LocalOutboxStore'
import { appRuntimeConfig, createHttpDiscoveryAdapter, getOrCreateBrowserDeviceId } from '../runtime/appRuntime'
import { useIdentity } from './IdentityContext'
// Yjs and Automerge adapters are dynamically imported to keep WASM out of the default bundle

const USE_YJS = import.meta.env.VITE_CRDT !== 'automerge'
const VERIFICATION_ATTESTATION_CLAIM = 'in-person verifiziert'

function isVerificationAttestation(attestation: Attestation): boolean {
  return attestation.claim === VERIFICATION_ATTESTATION_CLAIM && Boolean(attestation.vcJws)
}

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
    let replicationAdapter: AutomergeReplicationAdapter | YjsReplicationAdapter | null = null
    let localCacheStore: LocalCacheStore | null = null
    let spaceCompactStore: CompactStorageManager | null = null
    let offlineHandler: (() => void) | null = null
    let unsubRemoteSync: (() => void) | null = null

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
          for (const dbName of ['wot-space-metadata', 'automerge-repo', 'wot-local-cache', 'wot-space-compact-store', 'wot-space-sync-states', 'wot-yjs-compact-store', 'wot-personal-doc', 'automerge-personal', 'web-of-trust']) {
            try { await new Promise<void>((resolve, reject) => {
              const req = indexedDB.deleteDatabase(dbName)
              req.onsuccess = () => resolve()
              req.onerror = () => reject(req.error)
            }) } catch { /* best effort */ }
          }
        }
        localStorage.setItem('wot-active-did', did)
        lap('identity-check')

        // Create WebSocket adapter — try to connect quickly, but don't block init
        const wsAdapter = new WebSocketMessagingAdapter(appRuntimeConfig.relayUrl, {
          deviceId: getOrCreateBrowserDeviceId(did),
          signBrokerAuthTranscript: (bytes: Uint8Array) => identity.signEd25519(bytes),
        })
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

        // Restore persisted delivery statuses, then overlay outbox state
        const savedStatuses = await storage.getAllDeliveryStatuses()
        attestationService.restoreDeliveryStatuses(savedStatuses)
        attestationService.initFromOutbox(outboxStore)

        lap('attestation-service')
        const keyManagement = new InMemoryKeyManagementAdapter()
        const spaceMetadataStorage = new PersonalDocSpaceMetadataStorage(docFns)
        spaceCompactStore = new CompactStorageManager('wot-space-compact-store')
        await spaceCompactStore.open()
        if (USE_YJS) {
          const { YjsReplicationAdapter, flushYjsPersonalDoc, refreshYjsPersonalDocFromVault } = await import('@web_of_trust/adapter-yjs')
          replicationAdapter = new YjsReplicationAdapter({
            identity,
            messaging: outboxAdapter,
            keyManagement,
            metadataStorage: spaceMetadataStorage,
            compactStore: spaceCompactStore,
            vaultUrl: appRuntimeConfig.vaultUrl,
            brokerUrls: [appRuntimeConfig.relayUrl],
            flushPersonalDoc: flushYjsPersonalDoc,
            refreshPersonalDocFromVault: refreshYjsPersonalDocFromVault,
          })
        } else {
          const { AutomergeReplicationAdapter, SyncOnlyStorageAdapter } = await import('@web_of_trust/adapter-automerge')
          const spaceSyncStorage = new SyncOnlyStorageAdapter('wot-space-sync-states')
          replicationAdapter = new AutomergeReplicationAdapter({
            identity,
            messaging: outboxAdapter,
            keyManagement,
            metadataStorage: spaceMetadataStorage,
            repoStorage: spaceSyncStorage,
            compactStore: spaceCompactStore,
            vaultUrl: appRuntimeConfig.vaultUrl,
            brokerUrls: [appRuntimeConfig.relayUrl],
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
            // Recovery/Import — try to restore data from wot-profiles server
            console.log('[restore] Attempting restore from wot-profiles server...')
            try {
              const serverResult = await httpDiscovery.resolveProfile(did)
              console.log('[restore] Server profile result:', serverResult.profile ? `name="${serverResult.profile.name}"` : 'no profile')
              const restoredProfile = serverResult.profile
                ? {
                    name: serverResult.profile.name ?? '',
                    ...(serverResult.profile.bio ? { bio: serverResult.profile.bio } : {}),
                    ...(serverResult.profile.avatar ? { avatar: serverResult.profile.avatar } : {}),
                  }
                : { name: '' }

              if (existing) {
                await storage.updateIdentity({ ...existing, profile: restoredProfile, updatedAt: new Date().toISOString() })
              } else {
                await storage.createIdentity(did, restoredProfile)
              }

              const attestations = await httpDiscovery.resolveAttestations(did)
              console.log('[restore] Attestations:', attestations.length)

              const contactTimestamps = new Map<string, string>()
              const recordVerificationPartner = (attestation: Attestation) => {
                if (!isVerificationAttestation(attestation)) return
                if (attestation.from !== did && attestation.to !== did) return

                const contactDid = attestation.from === did ? attestation.to : attestation.from
                const current = contactTimestamps.get(contactDid)
                if (!current || attestation.createdAt < current) {
                  contactTimestamps.set(contactDid, attestation.createdAt)
                }
              }

              for (const attestation of attestations) {
                await storage.saveAttestation(attestation)
                await storage.setAttestationAccepted(attestation.id, true)
                recordVerificationPartner(attestation)
              }

              await Promise.all(Array.from(contactTimestamps.keys()).map(async (contactDid) => {
                const contactAttestations = await httpDiscovery.resolveAttestations(contactDid).catch((error) => {
                  console.warn('[restore] Failed to resolve peer attestations for contact:', contactDid, error)
                  return []
                })
                for (const attestation of contactAttestations) {
                  if (attestation.from === did && attestation.to === contactDid && isVerificationAttestation(attestation)) {
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

              console.log('[restore] Restored data from wot-profiles server:', restoredProfile.name || '(no name)')
              getMetrics().logLoad('wot-profiles', 0, 0)
            } catch (err) {
              console.warn('[restore] Could not restore from server (offline?):', err)
              // Fallback: create empty identity only if none exists
              if (!existing) {
                await storage.createIdentity(did, { name: '' })
              }
            }
          }
        }

        // syncDiscovery: retries all pending publish operations
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
              const result: {
                profile?: PublicProfile
                attestations?: PublicAttestationsData
              } = {}
              if (localIdentity) {
                result.profile = {
                  did,
                  name: localIdentity.profile.name,
                  ...(localIdentity.profile.bio ? { bio: localIdentity.profile.bio } : {}),
                  ...(localIdentity.profile.avatar ? { avatar: localIdentity.profile.avatar } : {}),
                  updatedAt: new Date().toISOString(),
                }
              }
              if (accepted.length > 0) {
                result.attestations = { did, attestations: accepted, updatedAt: new Date().toISOString() }
              }
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
      outboxAdapter?.disconnect()
      localCacheStore?.close()
      spaceCompactStore?.close()
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
