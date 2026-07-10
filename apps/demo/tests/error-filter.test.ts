import { describe, it, expect } from 'vitest'
import { isForeignError } from '../src/error-filter'

describe('isForeignError — global handler guard', () => {
  it('ignores the Firefox-iOS injected-script error seen at DWeb Camp', () => {
    // Real message from the field: "ReferenceError: Can't find variable: __firefox__"
    expect(isForeignError("Can't find variable: __firefox__", true)).toBe(true)
  })

  it('ignores other browser content-script injections (Chrome/Brave iOS)', () => {
    expect(isForeignError("Can't find variable: __gCrWeb", true)).toBe(true)
    expect(isForeignError('__brave is not defined', true)).toBe(true)
    expect(isForeignError("undefined is not an object (evaluating 'webkit.messageHandlers.x')", true)).toBe(true)
  })

  it('ignores cross-origin "Script error." with no Error object', () => {
    expect(isForeignError('Script error.', false)).toBe(true)
    expect(isForeignError('', false)).toBe(true)
    expect(isForeignError(undefined, false)).toBe(true)
  })

  it('SURFACES genuine same-origin app errors (must still nuke to the crash screen)', () => {
    expect(isForeignError('Cannot read properties of undefined (reading foo)', true)).toBe(false)
    expect(isForeignError('Invalid BIP39 seed hex', true)).toBe(false)
    expect(isForeignError('X25519 public key export failed', true)).toBe(false)
  })

  it('does not swallow a real "Script error." that carries an Error object', () => {
    // If a same-origin error somehow reports as "Script error." but WITH an Error
    // object, treat it as real (only the detail-free cross-origin case is foreign).
    expect(isForeignError('Script error.', true)).toBe(false)
  })
})
