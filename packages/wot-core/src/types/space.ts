export type ReplicationState = 'idle' | 'syncing' | 'error'

export interface SpaceInfo {
  id: string
  type: 'personal' | 'shared'
  name?: string
  description?: string
  members: string[] // DIDs
  createdAt: string
}

export interface SpaceMemberChange {
  spaceId: string
  did: string
  action: 'added' | 'removed'
}
