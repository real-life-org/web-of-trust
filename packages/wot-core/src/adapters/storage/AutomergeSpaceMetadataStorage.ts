/**
 * AutomergeSpaceMetadataStorage - SpaceMetadataStorage backed by Personal Automerge Doc
 *
 * Replaces IndexedDBSpaceMetadataStorage. Stores space metadata + group keys
 * in the personal doc so they sync to other devices automatically.
 */
import type {
  SpaceMetadataStorage,
  PersistedSpaceMetadata,
  PersistedGroupKey,
} from '../interfaces/SpaceMetadataStorage'
import {
  getPersonalDoc as defaultGetPersonalDoc,
  changePersonalDoc as defaultChangePersonalDoc,
} from '../../storage/PersonalDocManager'
import type { PersonalDoc } from '../../storage/PersonalDocManager'

export interface SpaceMetadataDocFunctions {
  getPersonalDoc: () => PersonalDoc
  changePersonalDoc: (fn: (doc: PersonalDoc) => void, options?: { background?: boolean }) => PersonalDoc
}

function groupKeyId(spaceId: string, generation: number): string {
  return `${spaceId}:${generation}`
}

export class AutomergeSpaceMetadataStorage implements SpaceMetadataStorage {
  private getPersonalDoc: () => PersonalDoc
  private changePersonalDoc: (fn: (doc: PersonalDoc) => void, options?: { background?: boolean }) => PersonalDoc

  constructor(fns?: SpaceMetadataDocFunctions) {
    this.getPersonalDoc = fns?.getPersonalDoc ?? defaultGetPersonalDoc
    this.changePersonalDoc = fns?.changePersonalDoc ?? defaultChangePersonalDoc
  }

  async saveSpaceMetadata(meta: PersistedSpaceMetadata): Promise<void> {
    this.changePersonalDoc(doc => {
      const info: Record<string, unknown> = {
        id: meta.info.id,
        type: meta.info.type,
        name: meta.info.name ?? null,
        description: meta.info.description ?? null,
        members: [...meta.info.members],
        createdAt: meta.info.createdAt,
      }
      if (meta.info.appTag != null) info.appTag = meta.info.appTag
      doc.spaces[meta.info.id] = {
        info: info as any,
        documentId: meta.documentId,
        documentUrl: meta.documentUrl,
        memberEncryptionKeys: Object.fromEntries(
          Object.entries(meta.memberEncryptionKeys).map(
            ([did, key]) => [did, Array.from(key as Uint8Array)]
          )
        ),
      }
    })
  }

  async loadSpaceMetadata(spaceId: string): Promise<PersistedSpaceMetadata | null> {
    const doc = this.getPersonalDoc()
    const stored = doc.spaces[spaceId]
    if (!stored) return null
    return this.deserialize(stored)
  }

  async loadAllSpaceMetadata(): Promise<PersistedSpaceMetadata[]> {
    const doc = this.getPersonalDoc()
    return Object.values(doc.spaces).map(s => this.deserialize(s))
  }

  async deleteSpaceMetadata(spaceId: string): Promise<void> {
    this.changePersonalDoc(doc => {
      delete doc.spaces[spaceId]
    })
  }

  async saveGroupKey(key: PersistedGroupKey): Promise<void> {
    const id = groupKeyId(key.spaceId, key.generation)
    this.changePersonalDoc(doc => {
      doc.groupKeys[id] = {
        spaceId: key.spaceId,
        generation: key.generation,
        key: Array.from(key.key),
      }
    })
  }

  async loadGroupKeys(spaceId: string): Promise<PersistedGroupKey[]> {
    const doc = this.getPersonalDoc()
    return Object.values(doc.groupKeys)
      .filter(k => k.spaceId === spaceId)
      .map(k => ({
        spaceId: k.spaceId,
        generation: k.generation,
        key: new Uint8Array(k.key),
      }))
  }

  async deleteGroupKeys(spaceId: string): Promise<void> {
    this.changePersonalDoc(doc => {
      for (const [key, gk] of Object.entries(doc.groupKeys)) {
        if (gk.spaceId === spaceId) delete doc.groupKeys[key]
      }
    })
  }

  async clearAll(): Promise<void> {
    this.changePersonalDoc(doc => {
      for (const key of Object.keys(doc.spaces)) {
        delete doc.spaces[key]
      }
      for (const key of Object.keys(doc.groupKeys)) {
        delete doc.groupKeys[key]
      }
    })
  }

  private deserialize(stored: {
    info: { id: string; type: string; name: string | null; description: string | null; appTag?: string; members: string[]; createdAt: string }
    documentId: string
    documentUrl: string
    memberEncryptionKeys: Record<string, number[]>
  }): PersistedSpaceMetadata {
    return {
      info: {
        id: stored.info.id,
        type: stored.info.type as 'personal' | 'shared',
        ...(stored.info.name != null ? { name: stored.info.name } : {}),
        ...(stored.info.description != null ? { description: stored.info.description } : {}),
        ...(stored.info.appTag != null ? { appTag: stored.info.appTag } : {}),
        members: [...stored.info.members],
        createdAt: stored.info.createdAt,
      },
      documentId: stored.documentId,
      documentUrl: stored.documentUrl,
      memberEncryptionKeys: Object.fromEntries(
        Object.entries(stored.memberEncryptionKeys).map(
          ([did, arr]) => [did, new Uint8Array(arr)]
        )
      ),
    }
  }
}
