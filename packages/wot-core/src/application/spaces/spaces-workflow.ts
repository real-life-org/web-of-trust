import { decodeBase64Url } from '../../protocol'
import type { SpaceMemberKeyDirectory, SpaceReplicationPort } from '../../ports'
import type { SpaceDocMeta, SpaceInfo } from '../../types/space'

export interface SpacesWorkflowOptions {
  replication: SpaceReplicationPort
  memberKeys?: SpaceMemberKeyDirectory
  appTag?: string
  defaultInitialDoc?: () => unknown
}

export interface CreateSpaceInput {
  name: string
  description?: string
  type?: SpaceInfo['type']
  initialDoc?: unknown
  appTag?: string
}

export interface InviteMemberInput {
  spaceId: string
  memberDid: string
}

export class SpacesWorkflow {
  private readonly replication: SpaceReplicationPort
  private readonly memberKeys: SpaceMemberKeyDirectory | null
  private readonly appTag: string | undefined
  private readonly createDefaultInitialDoc: () => unknown

  constructor(options: SpacesWorkflowOptions) {
    this.replication = options.replication
    this.memberKeys = options.memberKeys ?? null
    this.appTag = options.appTag
    this.createDefaultInitialDoc = options.defaultInitialDoc ?? (() => ({}))
  }

  watchSpaces() {
    return this.replication.watchSpaces()
  }

  listSpaces(): Promise<SpaceInfo[]> {
    return this.replication.getSpaces()
  }

  getSpace(spaceId: string): Promise<SpaceInfo | null> {
    return this.replication.getSpace(requireValue(spaceId, 'spaceId'))
  }

  async createSpace(input: CreateSpaceInput): Promise<SpaceInfo> {
    const name = requireValue(input.name.trim(), 'space name')
    const appTag = input.appTag ?? this.appTag
    const meta = {
      name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(appTag !== undefined ? { appTag } : {}),
    }
    return this.replication.createSpace(input.type ?? 'shared', input.initialDoc ?? this.createDefaultInitialDoc(), meta)
  }

  updateSpace(spaceId: string, meta: SpaceDocMeta): Promise<void> {
    return this.replication.updateSpace(requireValue(spaceId, 'spaceId'), meta)
  }

  async inviteMember(input: InviteMemberInput): Promise<void> {
    const memberDid = requireValue(input.memberDid, 'memberDid')
    const encodedKey = await this.requireMemberKeys().resolveMemberEncryptionKey(memberDid)
    if (!encodedKey) throw new Error('NO_ENCRYPTION_KEY')
    await this.replication.addMember(requireValue(input.spaceId, 'spaceId'), memberDid, decodeBase64Url(encodedKey))
  }

  removeMember(input: InviteMemberInput): Promise<void> {
    return this.replication.removeMember(requireValue(input.spaceId, 'spaceId'), requireValue(input.memberDid, 'memberDid'))
  }

  leaveSpace(spaceId: string): Promise<void> {
    return this.replication.leaveSpace(requireValue(spaceId, 'spaceId'))
  }

  requestSync(spaceId = '__all__'): Promise<void> {
    return this.replication.requestSync(spaceId)
  }

  private requireMemberKeys(): SpaceMemberKeyDirectory {
    if (!this.memberKeys) throw new Error('Space member key directory is required')
    return this.memberKeys
  }
}

function requireValue(value: string, label: string): string {
  if (!value) throw new Error(`Missing ${label}`)
  return value
}
