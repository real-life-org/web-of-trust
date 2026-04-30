import { describe, expect, it } from 'vitest'
import { SpacesWorkflow } from '../src/application'
import { encodeBase64Url } from '../src/protocol'
import type { SpaceMemberKeyDirectory, SpaceReplicationPort } from '../src/ports'
import type { SpaceDocMeta, SpaceInfo } from '../src/types/space'

class MemorySpaces implements SpaceReplicationPort {
  spaces: SpaceInfo[] = []
  createCalls: Array<{ type: SpaceInfo['type']; initialDoc: unknown; meta?: { name?: string; description?: string; appTag?: string } }> = []
  updateCalls: Array<{ spaceId: string; meta: SpaceDocMeta }> = []
  addMemberCalls: Array<{ spaceId: string; memberDid: string; memberEncryptionPublicKey: Uint8Array }> = []
  removeMemberCalls: Array<{ spaceId: string; memberDid: string }> = []
  leaveCalls: string[] = []
  syncCalls: string[] = []

  async createSpace<T>(type: SpaceInfo['type'], initialDoc: T, meta?: { name?: string; description?: string; appTag?: string }): Promise<SpaceInfo> {
    this.createCalls.push({ type, initialDoc, meta })
    const space: SpaceInfo = {
      id: `space-${this.createCalls.length}`,
      type,
      name: meta?.name,
      description: meta?.description,
      appTag: meta?.appTag,
      members: ['did:key:zAlice'],
      createdAt: '2026-04-28T08:00:00.000Z',
    }
    this.spaces.push(space)
    return space
  }

  async updateSpace(spaceId: string, meta: SpaceDocMeta): Promise<void> {
    this.updateCalls.push({ spaceId, meta })
  }

  async getSpaces(): Promise<SpaceInfo[]> {
    return this.spaces
  }

  async getSpace(spaceId: string): Promise<SpaceInfo | null> {
    return this.spaces.find(space => space.id === spaceId) ?? null
  }

  watchSpaces() {
    return {
      subscribe: () => () => {},
      getValue: () => this.spaces,
    }
  }

  async addMember(spaceId: string, memberDid: string, memberEncryptionPublicKey: Uint8Array): Promise<void> {
    this.addMemberCalls.push({ spaceId, memberDid, memberEncryptionPublicKey })
  }

  async removeMember(spaceId: string, memberDid: string): Promise<void> {
    this.removeMemberCalls.push({ spaceId, memberDid })
  }

  async leaveSpace(spaceId: string): Promise<void> {
    this.leaveCalls.push(spaceId)
  }

  async requestSync(spaceId: string): Promise<void> {
    this.syncCalls.push(spaceId)
  }
}

class MemoryMemberKeys implements SpaceMemberKeyDirectory {
  keys = new Map<string, string>()

  async resolveMemberEncryptionKey(did: string): Promise<string | null> {
    return this.keys.get(did) ?? null
  }
}

describe('SpacesWorkflow', () => {
  it('creates shared spaces with the configured default document and app tag', async () => {
    const spaces = new MemorySpaces()
    const workflow = new SpacesWorkflow({
      replication: spaces,
      appTag: 'wot-demo',
      defaultInitialDoc: () => ({ notes: '' }),
    })

    const created = await workflow.createSpace({ name: '  Project Room  ', description: 'Shared planning' })

    expect(created).toMatchObject({
      id: 'space-1',
      type: 'shared',
      name: 'Project Room',
      description: 'Shared planning',
      appTag: 'wot-demo',
    })
    expect(spaces.createCalls).toEqual([
      {
        type: 'shared',
        initialDoc: { notes: '' },
        meta: { name: 'Project Room', description: 'Shared planning', appTag: 'wot-demo' },
      },
    ])
  })

  it('invites members by resolving and decoding their encryption key', async () => {
    const spaces = new MemorySpaces()
    const memberKeys = new MemoryMemberKeys()
    memberKeys.keys.set('did:key:zBob', encodeBase64Url(new Uint8Array([1, 2, 3, 4])))
    const workflow = new SpacesWorkflow({ replication: spaces, memberKeys })

    await workflow.inviteMember({ spaceId: 'space-1', memberDid: 'did:key:zBob' })

    expect(spaces.addMemberCalls).toEqual([
      {
        spaceId: 'space-1',
        memberDid: 'did:key:zBob',
        memberEncryptionPublicKey: new Uint8Array([1, 2, 3, 4]),
      },
    ])
  })

  it('rejects invites when no member encryption key can be resolved', async () => {
    const spaces = new MemorySpaces()
    const workflow = new SpacesWorkflow({ replication: spaces, memberKeys: new MemoryMemberKeys() })

    await expect(
      workflow.inviteMember({ spaceId: 'space-1', memberDid: 'did:key:zBob' }),
    ).rejects.toThrow('NO_ENCRYPTION_KEY')
    expect(spaces.addMemberCalls).toEqual([])
  })

  it('delegates space updates, removals, leaving, and sync requests to the replication port', async () => {
    const spaces = new MemorySpaces()
    const workflow = new SpacesWorkflow({ replication: spaces })

    await workflow.updateSpace('space-1', { name: 'Renamed' })
    await workflow.removeMember({ spaceId: 'space-1', memberDid: 'did:key:zBob' })
    await workflow.leaveSpace('space-1')
    await workflow.requestSync()

    expect(spaces.updateCalls).toEqual([{ spaceId: 'space-1', meta: { name: 'Renamed' } }])
    expect(spaces.removeMemberCalls).toEqual([{ spaceId: 'space-1', memberDid: 'did:key:zBob' }])
    expect(spaces.leaveCalls).toEqual(['space-1'])
    expect(spaces.syncCalls).toEqual(['__all__'])
  })
})
