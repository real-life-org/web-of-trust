import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'
import {
  WebCryptoAdapter,
  WebSocketMessagingAdapter,
  HttpDiscoveryAdapter,
  OfflineFirstDiscoveryAdapter,
  OutboxMessagingAdapter,
  AutomergeReplicationAdapter,
  IndexedDBSpaceMetadataStorage,
  GroupKeyService,
  encodeBase64Url,
  type StorageAdapter,
  type ReactiveStorageAdapter,
  type CryptoAdapter,
  type MessagingAdapter,
  type MessagingState,
  type WotIdentity,
  type PublicProfile,
  type PublicVerificationsData,
  type PublicAttestationsData,
} from '@real-life/wot-core'
import {
  ContactService,
  VerificationService,
  AttestationService,
} from '../services'
import { EvoluStorageAdapter } from '../adapters/EvoluStorageAdapter'
import { EvoluPublishStateStore } from '../adapters/EvoluPublishStateStore'
import { EvoluGraphCacheStore } from '../adapters/EvoluGraphCacheStore'
import { EvoluOutboxStore } from '../adapters/EvoluOutboxStore'
import { createWotEvolu, isEvoluInitialized, getEvolu } from '../db'
import { useIdentity } from './IdentityContext'

const RELAY_URL = import.meta.env.VITE_RELAY_URL ?? 'wss://relay.utopia-lab.org'
const PROFILE_SERVICE_URL = import.meta.env.VITE_PROFILE_SERVICE_URL ?? 'http://localhost:8788'

interface AdapterContextValue {
  storage: StorageAdapter
  reactiveStorage: ReactiveStorageAdapter
  crypto: CryptoAdapter
  messaging: MessagingAdapter
  discovery: OfflineFirstDiscoveryAdapter
  replication: AutomergeReplicationAdapter
  publishStateStore: EvoluPublishStateStore
  graphCacheStore: EvoluGraphCacheStore
  outboxStore: EvoluOutboxStore
  messagingState: MessagingState
  contactService: ContactService
  verificationService: VerificationService
  attestationService: AttestationService
  syncDiscovery: () => Promise<void>
  flushOutbox: () => Promise<void>
  reconnectRelay: () => Promise<void>
  isInitialized: boolean
}

const AdapterContext = createContext<AdapterContextValue | null>(null)

interface AdapterProviderProps {
  children: ReactNode
  identity: WotIdentity
}

/**
 * AdapterProvider initializes Evolu with WotIdentity-derived custom keys.
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
    let replicationAdapter: AutomergeReplicationAdapter | null = null
    let reconnectTimer: ReturnType<typeof setInterval> | null = null
    let offlineHandler: (() => void) | null = null

    async function initAdapters() {
      try {
        const did = identity.getDid()

        // Clean up old Space/Automerge data when identity changes
        const previousDid = localStorage.getItem('wot-active-did')
        if (previousDid && previousDid !== did) {
          for (const dbName of ['wot-space-metadata', 'automerge-repo']) {
            try { await new Promise<void>((resolve, reject) => {
              const req = indexedDB.deleteDatabase(dbName)
              req.onsuccess = () => resolve()
              req.onerror = () => reject(req.error)
            }) } catch { /* best effort */ }
          }
        }
        localStorage.setItem('wot-active-did', did)

        const evolu = isEvoluInitialized()
          ? getEvolu()
          : await createWotEvolu(identity)

        const storage = new EvoluStorageAdapter(evolu, did)
        const crypto = new WebCryptoAdapter()
        const wsAdapter = new WebSocketMessagingAdapter(RELAY_URL)
        const outboxStore = new EvoluOutboxStore(evolu)
        outboxAdapter = new OutboxMessagingAdapter(wsAdapter, outboxStore, {
          skipTypes: ['profile-update', 'attestation-ack'],
          sendTimeoutMs: 15_000,
        })
        const httpDiscovery = new HttpDiscoveryAdapter(PROFILE_SERVICE_URL)
        const publishStateStore = new EvoluPublishStateStore(evolu, did)
        const graphCacheStore = new EvoluGraphCacheStore(evolu)
        const discovery = new OfflineFirstDiscoveryAdapter(httpDiscovery, publishStateStore, graphCacheStore)

        const attestationService = new AttestationService(storage, crypto)
        attestationService.setMessaging(outboxAdapter)
        attestationService.listenForReceipts(outboxAdapter)
        attestationService.setPersistDeliveryStatus((id, status) => storage.setDeliveryStatus(id, status))

        // Restore persisted delivery statuses, then overlay outbox state
        const savedStatuses = await storage.getAllDeliveryStatuses()
        attestationService.restoreDeliveryStatuses(savedStatuses)
        attestationService.initFromOutbox(outboxStore)

        const groupKeyService = new GroupKeyService()
        const spaceMetadataStorage = new IndexedDBSpaceMetadataStorage()
        const { IndexedDBStorageAdapter } = await import('@automerge/automerge-repo-storage-indexeddb')
        const repoStorage = new IndexedDBStorageAdapter()
        replicationAdapter = new AutomergeReplicationAdapter({
          identity,
          messaging: outboxAdapter,
          groupKeyService,
          metadataStorage: spaceMetadataStorage,
          repoStorage,
        })

        // Ensure identity exists in Evolu.
        // On a new device (recovery/import), Evolu may still be syncing from relay,
        // so we wait briefly before deciding to create a fresh profile.
        let existing = await storage.getIdentity()
        if (!existing && did) {
          // Wait for Evolu relay sync before creating empty profile
          await new Promise(resolve => setTimeout(resolve, 2000))
          existing = await storage.getIdentity()
        }
        let needsInitialSync = false
        if (!existing && did) {
          const profile = consumeInitialProfile() ?? { name: '' }
          await storage.createIdentity(did, profile)
          // Mark profile dirty so syncDiscovery() uploads it to wot-profiles
          if (profile.name) {
            await publishStateStore.markDirty(did, 'profile')
            needsInitialSync = true
          }
        }

        // syncDiscovery: retries all pending publish operations
        const syncDiscovery = async () => {
          try {
            await discovery.syncPending(did, identity, async () => {
              const localIdentity = await storage.getIdentity()
              const verifications = await storage.getReceivedVerifications()
              const allAttestations = await storage.getReceivedAttestations()
              const accepted = []
              for (const att of allAttestations) {
                const meta = await storage.getAttestationMetadata(att.id)
                if (meta?.accepted) accepted.push(att)
              }
              const result: {
                profile?: PublicProfile
                verifications?: PublicVerificationsData
                attestations?: PublicAttestationsData
              } = {}
              if (localIdentity) {
                const encPubKeyBytes = await identity.getEncryptionPublicKeyBytes()
                result.profile = {
                  did,
                  name: localIdentity.profile.name,
                  ...(localIdentity.profile.bio ? { bio: localIdentity.profile.bio } : {}),
                  ...(localIdentity.profile.avatar ? { avatar: localIdentity.profile.avatar } : {}),
                  encryptionPublicKey: encodeBase64Url(encPubKeyBytes),
                  updatedAt: new Date().toISOString(),
                }
              }
              if (verifications.length > 0) {
                result.verifications = { did, verifications, updatedAt: new Date().toISOString() }
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

        const reconnectRelay = async () => {
          const currentState = outboxAdapter!.getState()
          if (!did || currentState === 'connected' || currentState === 'connecting') return
          try {
            setMessagingState('connecting')
            await outboxAdapter!.connect(did)
            if (!cancelled) setMessagingState('connected')
          } catch (error) {
            console.warn('Relay reconnect failed:', error)
            if (!cancelled) setMessagingState('error')
          }
        }

        if (!cancelled) {
          // Start replication adapter BEFORE setting initialized,
          // so spaces are loaded from IndexedDB before UI renders
          await replicationAdapter!.start()

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
            verificationService: new VerificationService(storage),
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
                // Flush outbox + retry profile sync on reconnect
                if (state === 'connected') {
                  outboxAdapter!.flushOutbox()
                  syncDiscovery()
                }
              }
            })

            try {
              setMessagingState('connecting')
              await outboxAdapter.connect(did)
              if (!cancelled) setMessagingState('connected')
              console.log(`Relay connected: ${RELAY_URL} (${did.slice(0, 20)}...)`)
            } catch (error) {
              console.warn('Relay connection failed:', error)
              if (!cancelled) setMessagingState('error')
            }

            // Immediately disconnect WebSocket when browser goes offline
            offlineHandler = () => {
              if (!cancelled) {
                outboxAdapter!.disconnect()
                setMessagingState('disconnected')
              }
            }
            window.addEventListener('offline', offlineHandler)

            // Auto-reconnect: retry every 10s when disconnected
            reconnectTimer = setInterval(() => {
              if (cancelled) return
              if (!navigator.onLine) return // Don't retry while browser is offline
              const state = outboxAdapter!.getState()
              if (state === 'disconnected' || state === 'error') {
                reconnectRelay()
              }
            }, 10_000)
          }

          // After new identity creation, sync profile immediately.
          // Short delay ensures Evolu's upsert (markDirty) is persisted
          // before syncPending reads the dirty flags via loadQuery().
          if (needsInitialSync && !cancelled) {
            setTimeout(() => { syncDiscovery() }, 500)
          }

          // Ensure encryptionPublicKey is published (older profiles may lack it).
          // Check the published profile and re-publish if the key is missing.
          if (!needsInitialSync && !cancelled) {
            setTimeout(async () => {
              if (cancelled) return
              try {
                const result = await httpDiscovery.resolveProfile(did)
                if (result.profile && !result.profile.encryptionPublicKey) {
                  await publishStateStore.markDirty(did, 'profile')
                  await syncDiscovery()
                }
              } catch { /* offline — will retry next session */ }
            }, 2000)
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
      if (reconnectTimer) clearInterval(reconnectTimer)
      if (offlineHandler) window.removeEventListener('offline', offlineHandler)
      replicationAdapter?.stop().catch(() => {})
      outboxAdapter?.disconnect()
    }
  }, [identity])

  if (initError) {
    const isStorageBlocked = initError === 'storage-blocked'
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-md text-center space-y-4">
          <div className="text-4xl">&#9888;&#65039;</div>
          <h2 className="text-xl font-semibold text-slate-800">
            {isStorageBlocked ? 'Speicherzugriff blockiert' : 'Initialisierung fehlgeschlagen'}
          </h2>
          <p className="text-slate-600">
            {isStorageBlocked
              ? 'Die App benötigt Zugriff auf den lokalen Speicher, um deine Identität und Daten sicher auf deinem Gerät zu speichern. Bitte erlaube den Zugriff in den Browser-Einstellungen und lade die Seite neu.'
              : `Fehler: ${initError}`
            }
          </p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors"
          >
            Seite neu laden
          </button>
        </div>
      </div>
    )
  }

  if (!isInitialized || !adapters) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-slate-500">Initialisiere Evolu...</div>
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
