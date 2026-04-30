export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export function canonicalize(value: JsonValue): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JCS does not support non-finite numbers')
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`

  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
  return `{${entries.join(',')}}`
}

export function canonicalizeToBytes(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(canonicalize(value))
}
