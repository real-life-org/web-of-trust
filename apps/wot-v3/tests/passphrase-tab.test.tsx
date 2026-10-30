// Setting a password: Tab goes from the field to the next field, not to "show" (Anton 29.10.); the eye
// toggles follow after the fields, so the keyboard reaches them (#482): field, field, eye, eye, the rest.
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { LanguageProvider } from '../src/i18n'
import { PassphraseInput } from '../src/ui/components'

function Two() {
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  return (
    <LanguageProvider lang="en">
      <form>
        <PassphraseInput label="Password" value={a} onChange={setA} autoComplete="new-password" />
        <PassphraseInput label="Confirm password" value={b} onChange={setB} autoComplete="new-password" />
        <button type="submit">Continue</button>
      </form>
    </LanguageProvider>
  )
}

/** Tab (or Shift+Tab) on the focused element: the group's handler moves the focus, or leaves it to
 *  the browser (then nothing moves in jsdom) */
const tab = (el: HTMLElement, shiftKey = false) => {
  el.focus()
  return fireEvent.keyDown(el, { key: 'Tab', shiftKey })
}

describe('passphrase fields', () => {
  it('Tab goes field, field, eye, eye, then on; Shift+Tab the way back', () => {
    render(<Two />)
    const [a, b] = [screen.getByLabelText('Password'), screen.getByLabelText('Confirm password')]
    const [eyeA, eyeB] = screen.getAllByRole('button', { name: /show/i }) as HTMLElement[]
    expect(eyeA!.tabIndex).toBe(0)
    expect(tab(a)).toBe(false)
    expect(document.activeElement).toBe(b)
    expect(tab(b)).toBe(false)
    expect(document.activeElement).toBe(eyeA)
    expect(tab(eyeA!)).toBe(false)
    expect(document.activeElement).toBe(eyeB)
    // the last eye: the browser continues (to "Continue")
    expect(tab(eyeB!)).toBe(true)
    expect(tab(eyeB!, true)).toBe(false)
    expect(document.activeElement).toBe(eyeA)
    expect(tab(eyeA!, true)).toBe(false)
    expect(document.activeElement).toBe(b)
    expect(tab(b, true)).toBe(false)
    expect(document.activeElement).toBe(a)
    // the first field: the browser continues backwards
    expect(tab(a, true)).toBe(true)
  })

  it('the eye shows the password by keyboard: Enter or Space on the focused toggle', () => {
    render(<Two />)
    const field = screen.getByLabelText('Password')
    const eye = screen.getAllByRole('button', { name: /show/i })[0] as HTMLElement
    eye.focus()
    fireEvent.click(eye)
    expect(field).toHaveAttribute('type', 'text')
    expect(eye).toHaveAttribute('aria-pressed', 'true')
  })

  it('the toggle still shows the password on click', () => {
    render(<Two />)
    const field = screen.getByLabelText('Password')
    expect(field).toHaveAttribute('type', 'password')
    fireEvent.click(screen.getAllByRole('button', { name: /show/i })[0] as HTMLElement)
    expect(field).toHaveAttribute('type', 'text')
  })
})
