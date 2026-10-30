// The confirmation sheet comes unasked (the shell's queue, handshake UX 2.6): nothing is chosen by
// Enter (2.5). The first focus is the sheet itself, never a button; Enter right after it opens confirms
// no one (review of #474).
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createNavStore } from '../src/app/nav'
import { AppContextProvider } from '../src/hooks'
import { LanguageProvider } from '../src/i18n'
import { composeScenario } from '../harness/boot'
import { iiw } from '../harness/scenarios'
import { CounterSheet } from '../src/screens/contacts/CounterSheet'
import { MutualSheet } from '../src/screens/verify/MutualSheet'
import type { ContactId } from '../src/port'

function wrap(children: React.ReactNode) {
  const comp = composeScenario(iiw)
  return render(
    <LanguageProvider lang="en">
      <AppContextProvider value={{ port: comp.port, platform: comp.platform, nav: createNavStore() }}>{children}</AppContextProvider>
    </LanguageProvider>,
  )
}

describe('sheets that come unasked: no button has the first focus', () => {
  it('the incoming confirmation: focus on the sheet, Enter confirms nothing', async () => {
    const confirm = vi.fn()
    wrap(<CounterSheet contactId={'c' as ContactId} name="Jonas Weber" open when="now" onClose={() => undefined} run={{ busy: false, failed: false, confirm }} />)
    const dialog = await screen.findByRole('dialog')
    expect(document.activeElement).toBe(dialog)
    expect(document.activeElement?.tagName).not.toBe('BUTTON')
    fireEvent.keyDown(document.activeElement as Element, { key: 'Enter', code: 'Enter' })
    fireEvent.keyUp(document.activeElement as Element, { key: 'Enter', code: 'Enter' })
    expect(confirm).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('the success sheet: focus on the sheet, not on "Open chat"', async () => {
    const open = vi.fn()
    wrap(<MutualSheet contactId={'marcus' as never} name="Jonas Weber" onOpenChat={open} onClose={() => undefined} />)
    const dialog = await screen.findByRole('dialog')
    expect(document.activeElement).toBe(dialog)
    fireEvent.keyDown(document.activeElement as Element, { key: 'Enter', code: 'Enter' })
    expect(open).not.toHaveBeenCalled()
  })
})
