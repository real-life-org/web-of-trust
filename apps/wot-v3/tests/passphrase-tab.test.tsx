// Setting a password: Tab goes from the field to the next field, not to "show" (Anton 29.10.). The eye
// toggle stays a button for pointer and touch, outside the tab order.
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
      <PassphraseInput label="Password" value={a} onChange={setA} autoComplete="new-password" />
      <PassphraseInput label="Confirm password" value={b} onChange={setB} autoComplete="new-password" />
    </LanguageProvider>
  )
}

const tabbable = () =>
  [...document.querySelectorAll<HTMLElement>('input, button, [tabindex]')].filter((el) => el.tabIndex >= 0 && !el.hasAttribute('disabled'))

describe('passphrase fields', () => {
  it('Tab from one field reaches the next field; the show toggle is not in the tab order', () => {
    render(<Two />)
    expect(tabbable()).toEqual([screen.getByLabelText('Password'), screen.getByLabelText('Confirm password')])
  })

  it('the toggle still shows the password on click', () => {
    render(<Two />)
    const field = screen.getByLabelText('Password')
    expect(field).toHaveAttribute('type', 'password')
    fireEvent.click(screen.getAllByRole('button', { name: /show/i })[0] as HTMLElement)
    expect(field).toHaveAttribute('type', 'text')
  })
})
