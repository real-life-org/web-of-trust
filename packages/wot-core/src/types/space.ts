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
  /**
   * Creator-DID — read-only Projektion aus dem Space-Doc (`_meta.createdBy`,
   * VE-2). SPEC-APPROX: dient als Admin-Approximation (`knownAdminDids =
   * [createdBy]`), bis der admin-management-Slice die volle Admin-Liste bringt.
   * Optional: Alt-Spaces ohne `createdBy` fallen auf `members[0]` zurück.
   */
  createdBy?: string
  /**
   * Admin-DIDs — read-only Projektion der AKTIVEN Admins aus dem Space-Doc
   * (`_admins` ∩ aktive `_members`, Sync 005 Z.111-130, VE-1/VE-6). Additiv zum
   * Typ wie `members`/`createdBy`. Schreiber sind ausschliesslich `createSpace`
   * (Creator als erster Admin) + `promoteToAdmin`; ein als Member entfernter
   * Admin faellt automatisch aus dieser Liste (`resolveActiveAdmins`).
   * Optional: Alt-Spaces vor diesem Slice haben leeres `_admins` und fallen in
   * `spaceAdminDids` auf `[createdBy ?? members[0]]` zurueck.
   */
  admins?: string[]
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
