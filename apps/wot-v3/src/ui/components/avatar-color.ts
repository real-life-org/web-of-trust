// Avatar initials and palette, same algorithm as the prototype so colors match the design.

export function initials(name: string): string {
  const words = name.trim().split(/\s+/)
  const first = words[0] ?? ''
  const last = words[words.length - 1] ?? ''
  return words.length > 1 ? (first.charAt(0) + last.charAt(0)).toUpperCase() : name.slice(0, 2).toUpperCase()
}

function hash(s: string): number {
  let h = 0
  for (const ch of s) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  return h
}

/** 1..7, index into the --avatar-N-bg/fg tokens */
export function paletteIndex(name: string): number {
  return (hash(name) % 7) + 1
}
