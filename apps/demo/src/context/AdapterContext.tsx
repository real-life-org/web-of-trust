import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'
import {
  WebCryptoAdapter,
  WebSocketMessagingAdapter,
  HttpDiscoveryAdapter,
  OfflineFirstDiscoveryAdapter,
  OutboxMessagingAdapter,
  CompactStorageManager,
  GroupKeyService,
  encodeBase64Url,
  getMetrics,
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
import type { AutomergeReplicationAdapter } from '@real-life/adapter-automerge'
import type { YjsReplicationAdapter } from '@real-life/adapter-yjs'
import {
  ContactService,
  VerificationService,
  AttestationService,
} from '../services'
import {
  PersonalDocSpaceMetadataStorage,
} from '@real-life/wot-core'
import { AutomergePublishStateStore } from '../adapters/AutomergePublishStateStore'
import { AutomergeGraphCacheStore } from '../adapters/AutomergeGraphCacheStore'
import { LocalCacheStore } from '../adapters/LocalCacheStore'
import { LocalOutboxStore } from '../adapters/LocalOutboxStore'
// Yjs and Automerge adapters are dynamically imported to keep WASM out of the default bundle

const USE_YJS = import.meta.env.VITE_CRDT !== 'automerge'
import { useIdentity } from './IdentityContext'

const RELAY_URL = import.meta.env.VITE_RELAY_URL ?? 'wss://relay.utopia-lab.org'
const PROFILE_SERVICE_URL = import.meta.env.VITE_PROFILE_SERVICE_URL ?? 'http://localhost:8788'

interface AdapterContextValue {
  storage: StorageAdapter
  reactiveStorage: ReactiveStorageAdapter
  crypto: CryptoAdapter
  messaging: MessagingAdapter
  discovery: OfflineFirstDiscoveryAdapter
  replication: AutomergeReplicationAdapter | YjsReplicationAdapter
  publishStateStore: AutomergePublishStateStore
  graphCacheStore: AutomergeGraphCacheStore
  outboxStore: LocalOutboxStore
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
        const did = identity.getDid()

        // Clean up old data when identity changes (or after logout where previousDid was cleared)
        const previousDid = localStorage.getItem('wot-active-did')
        if (!previousDid || previousDid !== did) {
          if (USE_YJS) {
            const { deleteYjsPersonalDocDB } = await import('@real-life/adapter-yjs')
            await deleteYjsPersonalDocDB()
          } else {
            const { deletePersonalDocDB } = await import('@real-life/adapter-automerge')
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

        // Create WebSocket adapter — try to connect quickly, but don't block init
        const wsAdapter = new WebSocketMessagingAdapter(RELAY_URL)
        try {
          await Promise.race([
            wsAdapter.connect(did),
            new Promise((_, reject) => setTimeout(() => reject(new Error('WS connect timeout')), 3000)),
          ])
        } catch {
          console.warn('[init] WebSocket not connected yet, continuing with local data')
        }

        const VAULT_URL = 'https://vault.utopia-lab.org'

        // Initialize personal doc — loads from local IndexedDB first, syncs later via relay
        // Dynamic imports keep Automerge WASM (~2.6MB) out of the Yjs bundle
        let storage: StorageAdapter & ReactiveStorageAdapter
        if (USE_YJS) {
          const { initYjsPersonalDoc } = await import('@real-life/adapter-yjs')
          await initYjsPersonalDoc(identity, wsAdapter, VAULT_URL)
          console.debug('[init] Using Yjs PersonalDocManager')
          const { YjsStorageAdapter } = await import('../adapters/YjsStorageAdapter')
          storage = new YjsStorageAdapter(did)
        } else {
          const { isPersonalDocInitialized, initPersonalDoc } = await import('@real-life/adapter-automerge')
          if (!isPersonalDocInitialized()) {
            await initPersonalDoc(identity, wsAdapter, VAULT_URL)
          }
          console.debug('[init] Using Automerge PersonalDocManager')
          const { AutomergeStorageAdapter } = await import('../adapters/AutomergeStorageAdapter')
          storage = new AutomergeStorageAdapter(did)
        }
        const crypto = new WebCryptoAdapter()
        let docFns: { getPersonalDoc: any; changePersonalDoc: any; onPersonalDocChange: any }
        if (USE_YJS) {
          const { getYjsPersonalDoc, changeYjsPersonalDoc, onYjsPersonalDocChange } = await import('@real-life/adapter-yjs')
          docFns = {
            getPersonalDoc: getYjsPersonalDoc,
            changePersonalDoc: changeYjsPersonalDoc,
            onPersonalDocChange: onYjsPersonalDocChange,
          }
        } else {
          const { getPersonalDoc, changePersonalDoc, onPersonalDocChange } = await import('@real-life/adapter-automerge')
          docFns = {
            getPersonalDoc,
            changePersonalDoc,
            onPersonalDocChange,
          }
        }
        const httpDiscovery = new HttpDiscoveryAdapter(PROFILE_SERVICE_URL)
        localCacheStore = new LocalCacheStore('wot-local-cache')
        await localCacheStore.open()
        const outboxStore = new LocalOutboxStore(localCacheStore)
        outboxAdapter = new OutboxMessagingAdapter(wsAdapter, outboxStore, {
          // content = Automerge CRDT sync messages (high volume, auto-resync on reconnect)
          // personal-sync = multi-device personal doc sync (same reason)
          // profile-update / attestation-ack = fire-and-forget notifications
          skipTypes: ['content', 'profile-update', 'attestation-ack', 'personal-sync'],
          sendTimeoutMs: 15_000,
        })

        // One-time migration: copy cachedGraph + publishState from PersonalDoc to LocalCacheStore
        // (Automerge-only — Yjs docs don't have these legacy fields)
        if (!USE_YJS) try {
          const existingEntries = await localCacheStore.get('graph:entries')
          if (!existingEntries) {
            const { getPersonalDoc, changePersonalDoc } = await import('@real-life/adapter-automerge')
            const doc = getPersonalDoc() as any
            if (doc.cachedGraph?.entries && Object.keys(doc.cachedGraph.entries).length > 0) {
              await localCacheStore.set('graph:entries', JSON.parse(JSON.stringify(doc.cachedGraph.entries)))
              await localCacheStore.set('graph:verifications', JSON.parse(JSON.stringify(doc.cachedGraph.verifications ?? {})))
              await localCacheStore.set('graph:attestations', JSON.parse(JSON.stringify(doc.cachedGraph.attestations ?? {})))
              console.debug('[migration] Copied cachedGraph from PersonalDoc to LocalCacheStore')
            }
            if (doc.publishState && Object.keys(doc.publishState).length > 0) {
              await localCacheStore.set('publish-state', JSON.parse(JSON.stringify(doc.publishState)))
              console.debug('[migration] Copied publishState from PersonalDoc to LocalCacheStore')
            }
            // Clean up PersonalDoc — remove migrated fields to shrink the doc
            if (doc.cachedGraph || doc.publishState) {
              changePersonalDoc((d: any) => {
                delete d.cachedGraph
                delete d.publishState
              })
              console.debug('[migration] Removed cachedGraph + publishState from PersonalDoc')
            }
          }
        } catch (err) {
          console.warn('[migration] LocalCacheStore migration failed (non-fatal):', err)
        }

        const publishStateStore = new AutomergePublishStateStore(localCacheStore)
        const graphCacheStore = new AutomergeGraphCacheStore(localCacheStore)
        await Promise.all([publishStateStore.load(), graphCacheStore.load()])
        publishStateStore.setDid(did)
        const discovery = new OfflineFirstDiscoveryAdapter(httpDiscovery, publishStateStore, graphCacheStore)

        const attestationService = new AttestationService(storage, crypto)
        attestationService.setMessaging(outboxAdapter)
        attestationService.listenForReceipts(outboxAdapter)
        attestationService.setPersistDeliveryStatus((id, status) => (storage as any).setDeliveryStatus(id, status))

        // Restore persisted delivery statuses, then overlay outbox state
        const savedStatuses = await (storage as any).getAllDeliveryStatuses()
        attestationService.restoreDeliveryStatuses(savedStatuses)
        attestationService.initFromOutbox(outboxStore)

        const groupKeyService = new GroupKeyService()
        const spaceMetadataStorage = new PersonalDocSpaceMetadataStorage(docFns)
        spaceCompactStore = new CompactStorageManager('wot-space-compact-store')
        await spaceCompactStore.open()
        if (USE_YJS) {
          const { YjsReplicationAdapter } = await import('@real-life/adapter-yjs')
          replicationAdapter = new YjsReplicationAdapter({
            identity,
            messaging: outboxAdapter,
            groupKeyService,
            metadataStorage: spaceMetadataStorage,
            compactStore: spaceCompactStore,
            vaultUrl: VAULT_URL,
          })
        } else {
          const { AutomergeReplicationAdapter, SyncOnlyStorageAdapter } = await import('@real-life/adapter-automerge')
          const spaceSyncStorage = new SyncOnlyStorageAdapter('wot-space-sync-states')
          replicationAdapter = new AutomergeReplicationAdapter({
            identity,
            messaging: outboxAdapter,
            groupKeyService,
            metadataStorage: spaceMetadataStorage,
            repoStorage: spaceSyncStorage,
            compactStore: spaceCompactStore,
            vaultUrl: VAULT_URL,
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

              // Restore verifications + attestations from server (parallel)
              const [verifications, attestations] = await Promise.all([
                httpDiscovery.resolveVerifications(did),
                httpDiscovery.resolveAttestations(did),
              ])
              console.log('[restore] Verifications:', verifications.length, 'Attestations:', attestations.length)

              // Save verifications and collect contact DIDs
              const contactDids = new Set<string>()
              for (const v of verifications) {
                await storage.saveVerification(v)
                const contactDid = v.from === did ? v.to : v.from
                contactDids.add(contactDid)
              }

              // Save attestations
              for (const a of attestations) {
                await storage.saveAttestation(a)
                await storage.setAttestationAccepted(a.id, true)
              }

              // Load outgoing verifications + attestations from each contact (parallel)
              await Promise.all(Array.from(contactDids).map(async (contactDid) => {
                const [contactVerifications, contactAttestations] = await Promise.all([
                  httpDiscovery.resolveVerifications(contactDid).catch(() => []),
                  httpDiscovery.resolveAttestations(contactDid).catch(() => []),
                ])
                for (const v of contactVerifications) {
                  if (v.from === did && v.to === contactDid) {
                    await storage.saveVerification(v)
                  }
                }
                for (const a of contactAttestations) {
                  if (a.from === did && a.to === contactDid) {
                    const existingAtt = await storage.getAttestation(a.id)
                    if (!existingAtt) {
                      await storage.saveAttestation(a)
                    }
                  }
                }
              }))

              // Create contacts from verification partners
              for (const contactDid of contactDids) {
                const existingContact = await storage.getContact(contactDid)
                if (!existingContact) {
                  const earliest = verifications
                    .filter(v => v.from === contactDid || v.to === contactDid)
                    .map(v => v.timestamp)
                    .sort()[0] || new Date().toISOString()
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

        const metrics = getMetrics()

        const reconnectRelay = async () => {
          const currentState = outboxAdapter!.getState()
          if (!did || currentState === 'connected' || currentState === 'connecting') return
          try {
            setMessagingState('connecting')
            metrics.setRelayStatus(false, RELAY_URL, 0)
            await outboxAdapter!.connect(did)
            if (!cancelled) {
              setMessagingState('connected')
              metrics.setRelayStatus(true, RELAY_URL, wsAdapter.getPeerCount())
            }
          } catch (error) {
            console.warn('Relay reconnect failed:', error)
            if (!cancelled) {
              setMessagingState('error')
              metrics.setRelayStatus(false, RELAY_URL, 0)
            }
          }
        }

        if (!cancelled) {
          // Start replication adapter BEFORE setting initialized,
          // so spaces are loaded from IndexedDB before UI renders
          await replicationAdapter!.start()

          // Watch for remote personal doc sync (multi-device) — restore new spaces
          unsubRemoteSync = docFns.onPersonalDocChange(() => {
            replicationAdapter?.restoreSpacesFromMetadata()
          })

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
                metrics.setRelayStatus(state === 'connected', RELAY_URL, wsAdapter.getPeerCount())
                // Flush outbox + retry profile sync on reconnect
                if (state === 'connected') {
                  outboxAdapter!.flushOutbox()
                  syncDiscovery()
                }
              }
            })

            try {
              setMessagingState('connecting')
              metrics.setRelayStatus(false, RELAY_URL, 0)
              await outboxAdapter.connect(did)
              if (!cancelled) {
                setMessagingState('connected')
                metrics.setRelayStatus(true, RELAY_URL, wsAdapter.getPeerCount())
              }
              console.log(`Relay connected: ${RELAY_URL} (${did.slice(0, 20)}...)`)
            } catch (error) {
              console.warn('Relay connection failed:', error)
              if (!cancelled) {
                setMessagingState('error')
                metrics.setRelayStatus(false, RELAY_URL, 0)
              }
            }

            // Immediately disconnect WebSocket when browser goes offline
            offlineHandler = () => {
              if (!cancelled) {
                outboxAdapter!.disconnect()
                setMessagingState('disconnected')
                metrics.setRelayStatus(false, RELAY_URL, 0)
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
