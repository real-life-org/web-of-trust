import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'
import {
  WebCryptoAdapter,
  WebSocketMessagingAdapter,
  HttpDiscoveryAdapter,
  OfflineFirstDiscoveryAdapter,
  OutboxMessagingAdapter,
  AutomergeReplicationAdapter,
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
import { AutomergeStorageAdapter } from '../adapters/AutomergeStorageAdapter'
import { AutomergePublishStateStore } from '../adapters/AutomergePublishStateStore'
import { AutomergeGraphCacheStore } from '../adapters/AutomergeGraphCacheStore'
import { AutomergeOutboxStore } from '../adapters/AutomergeOutboxStore'
import { AutomergeSpaceMetadataStorage } from '../adapters/AutomergeSpaceMetadataStorage'
import {
  initPersonalDoc,
  deletePersonalDocDB,
  isPersonalDocInitialized,
  onPersonalDocChange,
} from '../personalDocManager'
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
  publishStateStore: AutomergePublishStateStore
  graphCacheStore: AutomergeGraphCacheStore
  outboxStore: AutomergeOutboxStore
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
    let replicationAdapter: AutomergeReplicationAdapter | null = null
    let offlineHandler: (() => void) | null = null
    let unsubRemoteSync: (() => void) | null = null

    async function initAdapters() {
      try {
        const did = identity.getDid()

        // Clean up old data when identity changes
        const previousDid = localStorage.getItem('wot-active-did')
        if (previousDid && previousDid !== did) {
          await deletePersonalDocDB()
          for (const dbName of ['wot-space-metadata', 'automerge-repo']) {
            try { await new Promise<void>((resolve, reject) => {
              const req = indexedDB.deleteDatabase(dbName)
              req.onsuccess = () => resolve()
              req.onerror = () => reject(req.error)
            }) } catch { /* best effort */ }
          }
        }
        localStorage.setItem('wot-active-did', did)

        // Create WebSocket adapter and connect BEFORE personal doc init,
        // so PersonalNetworkAdapter can receive sync messages from relay
        const wsAdapter = new WebSocketMessagingAdapter(RELAY_URL)
        await wsAdapter.connect(did)

        const VAULT_URL = 'https://vault.utopia-lab.org'

        // Initialize personal doc as Automerge doc with multi-device sync + vault
        if (!isPersonalDocInitialized()) {
          await initPersonalDoc(identity, wsAdapter, VAULT_URL)
        }

        const storage = new AutomergeStorageAdapter(did)
        const crypto = new WebCryptoAdapter()
        const outboxStore = new AutomergeOutboxStore()
        outboxAdapter = new OutboxMessagingAdapter(wsAdapter, outboxStore, {
          skipTypes: ['profile-update', 'attestation-ack', 'personal-sync'],
          sendTimeoutMs: 15_000,
        })
        const httpDiscovery = new HttpDiscoveryAdapter(PROFILE_SERVICE_URL)
        const publishStateStore = new AutomergePublishStateStore()
        publishStateStore.setDid(did)
        const graphCacheStore = new AutomergeGraphCacheStore()
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
        const spaceMetadataStorage = new AutomergeSpaceMetadataStorage()
        const { IndexedDBStorageAdapter } = await import('@automerge/automerge-repo-storage-indexeddb')
        const repoStorage = new IndexedDBStorageAdapter()
        replicationAdapter = new AutomergeReplicationAdapter({
          identity,
          messaging: outboxAdapter,
          groupKeyService,
          metadataStorage: spaceMetadataStorage,
          repoStorage,
          vaultUrl: VAULT_URL,
        })

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

              // Restore verifications from server (incoming: to=me)
              const verifications = await httpDiscovery.resolveVerifications(did)
              console.log('[restore] Verifications from server:', verifications.length)
              const contactDids = new Set<string>()
              for (const v of verifications) {
                await storage.saveVerification(v)
                const contactDid = v.from === did ? v.to : v.from
                contactDids.add(contactDid)
              }

              // Also load outgoing verifications from each contact's server profile
              // (my verification of them is published on THEIR profile, not mine)
              for (const contactDid of contactDids) {
                try {
                  const contactVerifications = await httpDiscovery.resolveVerifications(contactDid)
                  for (const v of contactVerifications) {
                    if (v.from === did && v.to === contactDid) {
                      await storage.saveVerification(v)
                    }
                  }
                } catch { /* best effort — contact's profile may not exist */ }
              }

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

              // Restore accepted attestations from server (incoming: to=me)
              const attestations = await httpDiscovery.resolveAttestations(did)
              console.log('[restore] Attestations (incoming) from server:', attestations.length)
              for (const a of attestations) {
                await storage.saveAttestation(a)
                await storage.setAttestationAccepted(a.id, true)
              }

              // Also load outgoing attestations from each contact's server profile
              // (attestations I sent are published on the RECIPIENT's profile)
              for (const contactDid of contactDids) {
                try {
                  const contactAttestations = await httpDiscovery.resolveAttestations(contactDid)
                  for (const a of contactAttestations) {
                    if (a.from === did && a.to === contactDid) {
                      const existingAtt = await storage.getAttestation(a.id)
                      if (!existingAtt) {
                        await storage.saveAttestation(a)
                      }
                    }
                  }
                } catch { /* best effort */ }
              }

              console.log('[restore] Restored data from wot-profiles server:', restoredProfile.name || '(no name)')
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

          // Watch for remote personal doc sync (multi-device) — restore new spaces
          unsubRemoteSync = onPersonalDocChange(() => {
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
        <div className="text-slate-500">Initialisiere...</div>
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
