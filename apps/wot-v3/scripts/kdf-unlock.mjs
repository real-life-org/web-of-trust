// One unlock of the vault as measured for architecture §5.2: PBKDF2-HMAC-SHA-256 with the given
// rounds, then AES-256-GCM decrypt of a payload of the vault's size, the same WebCrypto calls as
// open() in src/platform/seed-vault/format.ts. Shared by scripts/measure-kdf.mjs (Node, and
// serialised into a Chromium page) and the harness page harness.html?measure=kdf (on a phone).
// Only random data: no secret, no vault of the device is touched.

/** one unlock: import, derive, decrypt; returns ms. Self-contained (it is serialised as source). */
export async function unlockOnce(subtle, iterations) {
  const password = crypto.getRandomValues(new Uint8Array(24))
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const aad = new TextEncoder().encode('{"aead":"AES-256-GCM","format":"wot-v3-vault"}')
  const payload = crypto.getRandomValues(new Uint8Array(150))
  // the record is sealed with the same derivation outside the measurement
  const sealBase = await subtle.importKey('raw', password, 'PBKDF2', false, ['deriveKey'])
  const sealKey = await subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, sealBase, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, sealKey, payload)
  const t0 = performance.now()
  const base = await subtle.importKey('raw', password, 'PBKDF2', false, ['deriveKey'])
  const key = await subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
  await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, ct)
  return performance.now() - t0
}

/** median (an even count: the mean of the two middle samples), min and max */
export function stats(xs) {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  const median = s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
  return { median, min: s[0], max: s[s.length - 1] }
}
