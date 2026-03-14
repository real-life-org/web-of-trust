/**
 * AutomergePublishStateStore - PublishStateStore backed by Personal Automerge Doc
 *
 * Replaces EvoluPublishStateStore. Stores dirty flags in doc.publishState.
 */
import type { PublishStateStore, PublishStateField, Subscribable } from '@real-life/wot-core'
import {
  getPersonalDoc,
  changePersonalDoc,
  onPersonalDocChange,
} from '../personalDocManager'

export interface DirtyState {
  profile: boolean
  verifications: boolean
  attestations: boolean
}

export class AutomergePublishStateStore implements PublishStateStore {
  private did: string | null = null

  /** Set the DID for watchDirtyState(). Called once during init. */
  setDid(did: string): void {
    this.did = did
  }

  async markDirty(did: string, field: PublishStateField): Promise<void> {
    changePersonalDoc(doc => {
      if (!doc.publishState[did]) {
        doc.publishState[did] = {
          profileDirty: false,
          verificationsDirty: false,
          attestationsDirty: false,
        }
      }
      const state = doc.publishState[did]
      if (field === 'profile') state.profileDirty = true
      else if (field === 'verifications') state.verificationsDirty = true
      else if (field === 'attestations') state.attestationsDirty = true
    }, { background: true })
  }

  async clearDirty(did: string, field: PublishStateField): Promise<void> {
    changePersonalDoc(doc => {
      const state = doc.publishState[did]
      if (!state) return
      if (field === 'profile') state.profileDirty = false
      else if (field === 'verifications') state.verificationsDirty = false
      else if (field === 'attestations') state.attestationsDirty = false
    }, { background: true })
  }

  async getDirtyFields(did: string): Promise<Set<PublishStateField>> {
    const doc = getPersonalDoc()
    const state = doc.publishState[did]
    const result = new Set<PublishStateField>()
    if (!state) return result
    if (state.profileDirty) result.add('profile')
    if (state.verificationsDirty) result.add('verifications')
    if (state.attestationsDirty) result.add('attestations')
    return result
  }

  watchDirtyState(): Subscribable<DirtyState> {
    const did = this.did
    const getSnapshot = (): DirtyState => {
      if (!did) return { profile: false, verifications: false, attestations: false }
      const doc = getPersonalDoc()
      const state = doc.publishState[did]
      if (!state) return { profile: false, verifications: false, attestations: false }
      return {
        profile: state.profileDirty,
        verifications: state.verificationsDirty,
        attestations: state.attestationsDirty,
      }
    }

    let snapshot = getSnapshot()
    let snapshotKey = JSON.stringify(snapshot)

    return {
      subscribe: (callback) => {
        return onPersonalDocChange(() => {
          const next = getSnapshot()
          const nextKey = JSON.stringify(next)
          if (nextKey !== snapshotKey) {
            snapshot = next
            snapshotKey = nextKey
            callback(snapshot)
          }
        })
      },
      getValue: () => snapshot,
    }
  }
}
