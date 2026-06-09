export type ReplicationState = 'idle' | 'syncing' | 'error'

export interface SpaceInfo {
  id: string
  type: 'personal' | 'shared'
  name?: string
  description?: string
  image?: string
  modules?: string[]
  /** App identifier for cross-app space isolation (e.g. 'rls', 'wot-demo') */
  appTag?: string
  members: string[] // DIDs
  createdAt: string
}

export interface SpaceDocMeta {
  name?: string
  description?: string
  image?: string
  modules?: string[]
}

export interface SpaceMemberChange {
  spaceId: string
  did: string
  action: 'added' | 'removed'
}

/**
 * Decoded incoming space-invite event. The wire payload is an ECIES container
 * (1.B.3-key-rotation), so consumers (e.g. invite dialogs) must not parse
 * MessageEnvelope.payload — adapters emit this event after a verified apply.
 */
export interface IncomingSpaceInvite {
  spaceId: string
  spaceName?: string
  fromDid: string
}
