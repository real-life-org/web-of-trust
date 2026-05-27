import { createIdentityWorkflow } from './identityWorkflow'

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

  const allDbs = [
    'wot-space-metadata', 'automerge-repo', 'wot-local-cache',
    'wot-space-compact-store', 'wot-space-sync-states', 'wot-yjs-compact-store',
    'wot-personal-doc', 'automerge-personal', 'web-of-trust',
  ]

  for (const dbName of allDbs) {
    await deleteDatabase(dbName).catch(() => {})
  }

  localStorage.removeItem('wot-active-did')
}

function deleteDatabase(dbName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(dbName)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () => resolve()
  })
}
