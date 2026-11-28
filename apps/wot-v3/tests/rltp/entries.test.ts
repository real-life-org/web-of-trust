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
    expect(entryDedupe(e, 'block|bea', 'bea')).toBe('block|bea')
    expect(entryInput(e, input)).toBe(input)
  })

  it('the contact field of a dedupe key reads as its entry; a group id or a draft key that equals an alias does not', () => {
    const e = entryIds([contact('bea', ['bea-2', 'g1', 'd-1'])])
    expect(entryDedupe(e, 'invite|g1|bea-2', 'bea-2')).toBe('invite|g1|bea')
    expect(entryDedupe(e, 'send|d-1', 'bea-2')).toBe('send|d-1')
    expect(entryDedupe(e, 'setClass|bea-2|profile|off', 'bea-2')).toBe('setClass|bea|profile|off')
    // no typed contact field: nothing is read as a contact
    expect(entryDedupe(e, 'decide|g1', undefined)).toBe('decide|g1')
  })
})
