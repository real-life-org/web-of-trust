import { createIdentityWorkflow } from './identityWorkflow'
import { wipeAllLocalAppData } from './durableStoreWipe'

export async function resetLocalAppData(): Promise<void> {
  await createIdentityWorkflow().deleteStoredIdentity().catch(() => {})

  const { deletePersonalDocDB } = await import('@web_of_trust/adapter-automerge')
  await deletePersonalDocDB().catch(() => {})

  try {
    const { deleteYjsPersonalDocDB } = await import('@web_of_trust/adapter-yjs')
    await deleteYjsPersonalDocDB().catch(() => {})
  } catch {
    // adapter-yjs may not be available in every build target.
  }

  // Clean slate: legacy DBs + EVERY DID-aware durable store (incl. the raw key
  // material in IndexedDBKeyManagementAdapter, K1) + every deviceId key + the
  // active-DID marker. Centralized so reset / delete / fresh-start cannot drift.
  await wipeAllLocalAppData()
}
