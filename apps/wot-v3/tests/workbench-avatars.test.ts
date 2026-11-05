// The workbench's avatars (#517): God's eye draws every phone's own profile; a person's camera draws
// itself from its own profile and everyone else only as its device holds them.
import { describe, expect, it } from 'vitest'
import { avatarOf, avatarsSeenBy } from '../harness/workbench/avatars'

const own = new Map([
  ['jonas', avatarOf('Jonas Weber')],
  ['noah', avatarOf('Secret Rename', 'data:image/webp;base64,AAAA')],
  ['lea', avatarOf('Lea Brandt', 'data:image/webp;base64,BBBB')],
])

describe('the avatars a camera draws', () => {
  it("God's eye: every phone's own profile", () => {
    expect(avatarsSeenBy('god', own, {})).toBe(own)
  })

  it("Jonas's camera: Noah as Jonas's device holds him, not Noah's new profile", () => {
    const m = avatarsSeenBy('jonas', own, { jonas: { noah: { name: 'Noah Lindqvist', image: null } } })
    expect(m.get('jonas')?.name).toBe('Jonas Weber')
    expect(m.get('noah')).toMatchObject({ name: 'Noah Lindqvist', initials: 'NL', image: null })
  })

  it("a phone Jonas's device does not hold: no avatar, its picture never shows", () => {
    const m = avatarsSeenBy('jonas', own, { jonas: { noah: { name: 'Noah Lindqvist', image: null } } })
    expect(m.has('lea')).toBe(false)
  })

  it('a contact without a name: a placeholder, not the phone’s own name', () => {
    const m = avatarsSeenBy('jonas', own, { jonas: { noah: { name: null, image: null } } })
    expect(m.get('noah')?.name).toBe('?')
  })
})
