// FlowSheet (handshake UX round 2.3, E5): screen on the phone, dialog on the desktop; the flow never
// remounts when the presentation changes; Escape is the caller's back; a click beside does nothing.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../src/i18n'
import { FlowPage, FlowSheet } from '../src/ui/components'
import { App } from '../src/app/App'
import { composeIdentityScenario, composeScenario } from '../harness/boot'
import { freshInstall, iiw } from '../harness/scenarios'
import { WIDE_QUERY } from '../src/app/layout'
import type { ConversationKey } from '../src/port'

let mounts = 0
function Counter() {
  const [n, setN] = useState(() => {
    mounts += 1
    return 0
  })
  return (
    <FlowPage title="Verify in person" onBack={() => undefined} backKind="close">
      <button type="button" onClick={() => setN(n + 1)}>
        count {n}
      </button>
    </FlowPage>
  )
}

function view(as: 'screen' | 'sheet', onEscape = () => undefined, calm = false) {
  return (
    <LanguageProvider lang="en">
      <main>
        <button type="button">opener</button>
        <FlowSheet as={as} calm={calm} appName="Web of Trust" label="Web of Trust" onEscape={onEscape}>
          <Counter />
        </FlowSheet>
      </main>
    </LanguageProvider>
  )
}

describe('FlowSheet', () => {
  it('screen: inline, no dialog', () => {
    render(view('screen'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Verify in person' })).toBeInTheDocument()
  })

  it('sheet: a modal dialog named by the flow page title, focus inside', async () => {
    render(view('sheet'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleName('Verify in person')
    expect(dialog).toContainElement(screen.getByRole('button', { name: /count/ }))
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('the flow keeps its state across screen ⇄ sheet (no remount)', async () => {
    mounts = 0
    const { rerender } = render(view('screen'))
    fireEvent.click(screen.getByRole('button', { name: 'count 0' }))
    fireEvent.click(screen.getByRole('button', { name: 'count 1' }))
    rerender(view('sheet'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toContainElement(screen.getByRole('button', { name: 'count 2' }))
    rerender(view('screen'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'count 2' })).toBeInTheDocument()
    expect(mounts).toBe(1)
  })

  it('Escape is the caller’s back; a click beside the sheet does nothing', async () => {
    const onEscape = vi.fn()
    render(view('sheet', onEscape))
    const dialog = await screen.findByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onEscape).toHaveBeenCalledTimes(1)
    const overlay = document.querySelector('[data-slot=dialog-overlay]')
    expect(overlay).not.toBeNull()
    await act(async () => {
      fireEvent.pointerDown(overlay as Element)
      fireEvent.click(overlay as Element)
    })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(onEscape).toHaveBeenCalledTimes(1)
  })

  it('calm: the identity background carries the app mark, hidden from assistive technology', async () => {
    render(view('sheet', undefined, true))
    await screen.findByRole('dialog')
    expect(screen.queryByText('Web of Trust', { selector: 'span' })).not.toBeNull()
    expect(screen.queryByRole('dialog', { name: 'Verify in person' })).not.toBeNull()
  })

  it('focus returns to where it was when the sheet closes', async () => {
    const opener = () => screen.getByRole('button', { name: 'opener', hidden: true })
    const { rerender } = render(
      <LanguageProvider lang="en">
        <main>
          <button type="button">opener</button>
        </main>
      </LanguageProvider>,
    )
    opener().focus()
    rerender(view('sheet'))
    await screen.findByRole('dialog')
    rerender(
      <LanguageProvider lang="en">
        <main>
          <button type="button">opener</button>
        </main>
      </LanguageProvider>,
    )
    await act(async () => new Promise((r) => setTimeout(r, 10)))
    expect(document.activeElement).toBe(opener())
  })
})

// ── through the app: the gate and the shell decide with the viewport ───────────────────────────


/** a controllable viewport: matchMedia answers WIDE_QUERY with `wide` and tells its listeners */
function viewport(wide: boolean) {
  const listeners = new Set<() => void>()
  const state = { wide }
  const original = window.matchMedia
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query === WIDE_QUERY ? state.wide : false
    },
    media: query,
    onchange: null,
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true,
  })) as unknown as typeof window.matchMedia
  return {
    set(next: boolean) {
      state.wide = next
      act(() => listeners.forEach((cb) => cb()))
    },
    restore() {
      window.matchMedia = original
    },
  }
}

describe('flows through the app', () => {
  it('onboarding keeps its words when the phone turns to landscape and back (no new identity drawn)', async () => {
    const vp = viewport(false)
    try {
      render(<App composition={await composeIdentityScenario(freshInstall)} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Create identity' }))
      const words = async () => [...(await screen.findByRole('list', { name: 'Your 12 Magic Words' })).querySelectorAll('li')].map((li) => li.textContent)
      const before = await words()
      expect(screen.queryByRole('dialog')).toBeNull()
      vp.set(true)
      expect(await screen.findByRole('dialog')).toHaveAttribute('aria-modal', 'true')
      expect(await words()).toEqual(before)
      vp.set(false)
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(await words()).toEqual(before)
    } finally {
      vp.restore()
    }
  })

  it('desktop: verify opens as a sheet over the conversation, which stays in the detail column and is inert', async () => {
    const vp = viewport(true)
    try {
      const comp = composeScenario(iiw, { open: 'c:marcus' as ConversationKey })
      render(<App composition={comp} />)
      await screen.findByText('Marcus Chen verified you', { exact: true })
      fireEvent.click(screen.getAllByRole('button', { name: 'Verify in person' })[0] as HTMLElement)
      const dialog = await screen.findByRole('dialog', { name: 'Verify in person' })
      expect(dialog).toHaveAttribute('aria-modal', 'true')
      // the conversation is still rendered behind, inside the inert shell
      const behind = screen.getByText('Marcus Chen verified you', { exact: true })
      expect(behind.closest('[inert]')).not.toBeNull()
      expect(dialog.closest('[inert]')).toBeNull()
      // Escape is the flow's back: the flow ends, the conversation is the detail again
      fireEvent.keyDown(dialog, { key: 'Escape' })
      await act(async () => new Promise((r) => setTimeout(r, 10)))
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(screen.getByText('Marcus Chen verified you', { exact: true }).closest('[inert]')).toBeNull()
    } finally {
      vp.restore()
    }
  })

  it('phone: verify is the full screen as before, no dialog, nothing inert', async () => {
    const vp = viewport(false)
    try {
      render(<App composition={composeScenario(iiw)} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Verify in person' }))
      expect(await screen.findByRole('heading', { name: 'Verify in person' })).toBeInTheDocument()
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(document.querySelector('[inert]')).toBeNull()
    } finally {
      vp.restore()
    }
  })
})
