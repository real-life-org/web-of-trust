// Sending keeps the keyboard open (Tillmann, 03.11.): tapping the send button must not take the focus
// from the text field, or iOS and Android close the keyboard after every message. The button's
// mousedown (also the compatibility event of a touch) keeps the focus where it is; the click still sends.
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../src/i18n'
import { Composer } from '../src/ui/components'

function setup(onSend = vi.fn()) {
  render(
    <LanguageProvider lang="en">
      <Composer placeholder="Message Noah" lockedReason={null} value="Hello" onChange={() => {}} onSend={onSend} />
    </LanguageProvider>,
  )
  return { field: screen.getByRole('textbox', { name: 'Message Noah' }), send: screen.getByRole('button', { name: 'Send' }), onSend }
}

describe('Composer keeps the keyboard open when sending', () => {
  it('pressing the send button does not move the focus away from the field', () => {
    const { field, send, onSend } = setup()
    field.focus()
    expect(document.activeElement).toBe(field)
    // false: the default action (moving the focus to the button) was prevented
    expect(fireEvent.mouseDown(send)).toBe(false)
    fireEvent.click(send)
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(field)
  })

  it('Enter in the field sends and the field keeps the focus', () => {
    const { field, onSend } = setup()
    field.focus()
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(field)
  })
})
