export type SyncHeads = Readonly<Record<string, number>>

export type SyncResponseDisposition = 'request-next-page' | 'complete'

export type SyncHeadsComparison = 'consistent' | 'divergent'

export interface SyncResponseTruncation {
  truncated: boolean
}

export function deriveSyncStartSeq(heads: SyncHeads, deviceId: string): number {
  if (!Object.prototype.hasOwnProperty.call(heads, deviceId)) return 0

  const head = heads[deviceId]
  assertSyncHeadSeq(head)
  if (head === Number.MAX_SAFE_INTEGER) throw new Error('Sync head seq overflow')
  return head + 1
}

export function evaluateSyncResponseDisposition(response: SyncResponseTruncation): SyncResponseDisposition {
  return response.truncated ? 'request-next-page' : 'complete'
}

export function compareSyncHeads(left: SyncHeads, right: SyncHeads): SyncHeadsComparison {
  assertSyncHeads(left)
  assertSyncHeads(right)

  const leftDeviceIds = Object.keys(left)
  const rightDeviceIds = Object.keys(right)
  if (leftDeviceIds.length !== rightDeviceIds.length) return 'divergent'

  for (const deviceId of leftDeviceIds) {
    if (!Object.prototype.hasOwnProperty.call(right, deviceId)) return 'divergent'
    if (left[deviceId] !== right[deviceId]) return 'divergent'
  }

  return 'consistent'
}

function assertSyncHeads(heads: SyncHeads): void {
  for (const seq of Object.values(heads)) assertSyncHeadSeq(seq)
}

function assertSyncHeadSeq(seq: number): void {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('Invalid sync head seq')
}
