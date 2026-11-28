// The one reading of a contact id (entries.ts): an alias reads as its entry; only typed contact fields are
// read so (a dedupe key's group id or draft key is never taken for a contact id); without an alias every
// key and input stays as given, byte for byte.
import { describe, expect, it } from 'vitest'
import { entryDedupe, entryIds, entryInput, entryKey } from '../../src/adapters/rltp/entries'

const contact = (id: string, aliases: string[] = []) => ({ id, aliases }) as never

describe('entries: one reading of a contact id', () => {
  it('without an alias: the target, the dedupe key and the input stay as given', () => {
    const e = entryIds([contact('bea'), contact('cem')])
    const input = { contactId: 'bea', text: 'x' }
    expect(entryKey(e, 'c:bea')).toBe('c:bea')
    expect(entryDedupe(e, 'block|bea', 'bea', 1)).toBe('block|bea')
    expect(entryInput(e, input)).toBe(input)
  })

  it('the contact part of a command’s key reads as its entry, by its place in the key', () => {
    const e = entryIds([contact('bea', ['bea-2'])])
    expect(entryDedupe(e, 'invite|g1|bea-2', 'bea-2', 2)).toBe('invite|g1|bea')
    expect(entryDedupe(e, 'setClass|bea-2|profile|off', 'bea-2', 1)).toBe('setClass|bea|profile|off')
  })

  it('a draft key, a group id or a prompt that equals an alias is never read as a contact', () => {
    const e = entryIds([contact('bea', ['bea-2'])])
    // send: its key names the draft, no contact
    expect(entryDedupe(e, 'send|bea-2', 'bea-2', undefined)).toBe('send|bea-2')
    // invite: the group's part stays, also where it equals the alias
    expect(entryDedupe(e, 'invite|bea-2|bea-2', 'bea-2', 2)).toBe('invite|bea-2|bea')
    expect(entryDedupe(e, 'decide|bea-2', undefined, undefined)).toBe('decide|bea-2')
  })

  it('the contacts joined into an entry, asked by any of its ids', () => {
    const e = entryIds([contact('bea', ['bea-2']), contact('cem')])
    expect(e.aliasesOf('bea-2')).toEqual(['bea-2'])
    expect(e.aliasesOf('bea')).toEqual(['bea-2'])
    expect(e.aliasesOf('cem')).toEqual([])
  })
})
