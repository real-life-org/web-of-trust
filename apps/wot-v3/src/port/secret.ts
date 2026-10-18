// Runtime protection for secrets in memory (architecture §2.4, §5 "Secret<T> at runtime").
//
// The value lives in a module-private WeakMap, never in a field. The box itself has no enumerable
// properties; JSON, string conversion and Node's inspect yield '[redacted]'. The box is a callable
// object (an arrow function with a replaced prototype), which makes structuredClone throw a
// DataCloneError instead of silently copying an empty object.
//
// This only protects the box, not the values that exist after reveal(); see architecture §5.

import type { Secret } from './commands'

const values = new WeakMap<object, unknown>()
const REDACTED = '[redacted]'

export class SecretBox<T> {
  private constructor() {
    throw new TypeError('use secret(value)')
  }

  reveal(this: SecretBox<T>): T {
    if (!values.has(this)) throw new TypeError('not a secret')
    return values.get(this) as T
  }

  toJSON(): string {
    return REDACTED
  }

  toString(): string {
    return REDACTED
  }

  [Symbol.toPrimitive](): string {
    return REDACTED
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED
  }
}

/** Wraps a value as a Secret. */
export function secret<T>(value: T): Secret<T> {
  const box = (() => {
    throw new TypeError(REDACTED)
  }) as unknown as object
  Object.setPrototypeOf(box, SecretBox.prototype)
  // An arrow function still has own 'length' and 'name'; both are non-enumerable. Redefine 'name'
  // so no accidental label leaks through it.
  Object.defineProperty(box, 'name', { value: REDACTED })
  values.set(box, value)
  return Object.freeze(box) as unknown as Secret<T>
}

export function isSecret(v: unknown): v is Secret<unknown> {
  return (typeof v === 'function' || typeof v === 'object') && v !== null && values.has(v)
}
