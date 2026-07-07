/**
 * Framework-agnostic reactive primitive.
 * Maps directly to React's useSyncExternalStore.
 *
 * Implementors must:
 * - Call all subscribers when value changes
 * - Return the current value synchronously via getValue()
 * - Return an unsubscribe function from subscribe()
 */
export interface Subscribable<T> {
  subscribe(callback: (value: T) => void): () => void
  getValue(): T
}

/**
 * Wraps a Subscribable to skip the first emission after subscribe.
 *
 * Useful when subscribe() triggers an initial callback (e.g. current value)
 * but the consumer only wants subsequent changes (e.g. to avoid an
 * unnecessary upload on mount).
 */
export function skipFirst<T>(source: Subscribable<T>): Subscribable<T> {
  return {
    getValue: () => source.getValue(),
    subscribe: (callback: (value: T) => void) => {
      let first = true
      return source.subscribe((value) => {
        if (first) {
          first = false
          return
        }
        callback(value)
      })
    },
  }
}
