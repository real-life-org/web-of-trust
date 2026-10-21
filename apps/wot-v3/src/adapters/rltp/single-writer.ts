// One writer per holder (architecture §3.1): a Web Lock held while a holder is open. A second tab gets
// 'other-writer'. Without the Locks API (old WebView, tests) the lock is granted locally.

export interface SingleWriter {
  /** the release function, or null when another tab holds the lock */
  acquire(): Promise<(() => void) | null>
}

export function webLockWriter(locks: LockManager | null | undefined, name = 'wot-v3-holder'): SingleWriter {
  return {
    acquire() {
      if (!locks) return Promise.resolve(() => undefined)
      return new Promise((resolve, reject) => {
        let release: () => void = () => undefined
        const held = new Promise<void>((r) => (release = r))
        locks
          .request(name, { ifAvailable: true }, async (lock) => {
            if (!lock) {
              resolve(null)
              return
            }
            resolve(release)
            await held
          })
          .catch(reject)
      })
    },
  }
}
