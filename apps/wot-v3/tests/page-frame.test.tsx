// The frames of the desktop (canvas "WoT v3 Desktop-Layout", Anton 29.10.): a flow is a page, in the
// content column with the sidebar or, while the app is locked, the whole window without navigation;
// a question is a dialog. What E5 asked for stays: no end by accident, the page takes the focus when it
// opens unless a field took it, Escape is the flow's back except in a filled text field, focus returns
// where it was, and nothing remounts when a window crosses the breakpoint.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { describe, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../src/i18n'
import { FlowPage, PageFrame, keepsEscape, usePortalHost } from '../src/ui/components'
import { App } from '../src/app/App'
import { composeIdentityScenario, composeScenario } from '../harness/boot'
import { empty, freshInstall, iiw, locked } from '../harness/scenarios'
import { WIDE_QUERY } from '../src/app/layout'
import type { ConversationKey } from '../src/port'

let mounts = 0
function Counter({ onBack = () => undefined }: { onBack?: () => void }) {
  const [n, setN] = useState(() => {
    mounts += 1
    return 0
  })
  return (
    <FlowPage title="Verify in person" onBack={onBack} backKind="close">
      <button type="button" onClick={() => setN(n + 1)}>
        count {n}
      </button>
    </FlowPage>
  )
}

function framed(wide: boolean, variant: 'app' | 'standalone' = 'app', onEscape = () => undefined, onBack = () => undefined) {
  return (
    <LanguageProvider lang="en">
      <div>
        <button type="button">opener</button>
        <PageFrame variant={variant} wide={wide} onEscape={onEscape}>
          <Counter onBack={onBack} />
        </PageFrame>
      </div>
    </LanguageProvider>
  )
}

describe('PageFrame and FlowPage', () => {
  it('phone: the full screen as before: × in the header, no area link, no dialog', () => {
    const onBack = vi.fn()
    render(framed(false, 'app', undefined, onBack))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Verify in person' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Contacts' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('desktop, in the app: a page, not a dialog: one ‹ beside the title closes it, as in the contact details', () => {
    const onBack = vi.fn()
    render(framed(true, 'app', undefined, onBack))
    expect(screen.queryByRole('dialog')).toBeNull()
    // standing alone here (no shell around it) the page is a region without a main: the app variant
    // always hangs in the shell's main
    const region = screen.getByRole('heading', { name: 'Verify in person' }).closest('section') as HTMLElement
    // the flow's own content aside, the header has exactly one button: no area link, no ×
    expect(within(region.querySelector('header') as HTMLElement).getAllByRole('button')).toHaveLength(1)
    fireEvent.click(within(region).getByRole('button', { name: 'Close' }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('desktop, standalone: no area link; the title stays for screen readers, × closes', () => {
    const onBack = vi.fn()
    render(framed(true, 'standalone', undefined, onBack))
    expect(screen.queryByRole('button', { name: 'Contacts' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Verify in person', level: 1 })).toHaveClass('sr-only')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('desktop: the page takes the focus when it opens (its title), and gives it back when it closes', async () => {
    const opener = () => screen.getByRole('button', { name: 'opener' })
    const bare = (
      <LanguageProvider lang="en">
        <div>
          <button type="button">opener</button>
        </div>
      </LanguageProvider>
    )
    const { rerender } = render(bare)
    opener().focus()
    rerender(framed(true))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Verify in person' })))
    rerender(bare)
    expect(document.activeElement).toBe(opener())
  })

  it('phone: the focus stays where it was (as before)', () => {
    const { rerender } = render(
      <LanguageProvider lang="en">
        <div>
          <button type="button">opener</button>
        </div>
      </LanguageProvider>,
    )
    screen.getByRole('button', { name: 'opener' }).focus()
    rerender(framed(false))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'opener' }))
  })

  it('the flow keeps its state across phone ⇄ desktop (no remount)', () => {
    mounts = 0
    const { rerender } = render(framed(false))
    fireEvent.click(screen.getByRole('button', { name: 'count 0' }))
    fireEvent.click(screen.getByRole('button', { name: 'count 1' }))
    rerender(framed(true))
    expect(screen.getByRole('button', { name: 'count 2' })).toBeInTheDocument()
    rerender(framed(true, 'standalone'))
    rerender(framed(false))
    expect(screen.getByRole('button', { name: 'count 2' })).toBeInTheDocument()
    expect(mounts).toBe(1)
  })

  it('desktop: Escape is the caller’s back; inside a dialog over the page it is the dialog’s', () => {
    const onEscape = vi.fn()
    render(
      <>
        {framed(true, 'app', onEscape)}
        <div role="dialog" aria-modal="true">
          <button type="button">in the dialog</button>
        </div>
      </>,
    )
    fireEvent.keyDown(screen.getByRole('button', { name: 'count 0' }), { key: 'Escape' })
    expect(onEscape).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(screen.getByRole('button', { name: 'in the dialog' }), { key: 'Escape' })
    expect(onEscape).toHaveBeenCalledTimes(1)
  })

  it('phone: Escape does nothing (as before)', () => {
    const onEscape = vi.fn()
    render(framed(false, 'app', onEscape))
    fireEvent.keyDown(screen.getByRole('button', { name: 'count 0' }), { key: 'Escape' })
    expect(onEscape).not.toHaveBeenCalled()
  })
})

describe('the page landmark', () => {
  const page = (variant: 'app' | 'standalone') => (
    <LanguageProvider lang="en">
      <PageFrame variant={variant} wide onEscape={() => undefined}>
        <Counter />
      </PageFrame>
    </LanguageProvider>
  )

  it('without navigation the page is the main; in the app a region of the shell’s main; the same element either way', () => {
    const { rerender } = render(page('standalone'))
    const main = screen.getByRole('main', { name: 'Verify in person' })
    rerender(page('app'))
    const region = screen.getByRole('region', { name: 'Verify in person' })
    expect(region).toBe(main)
    expect(screen.queryByRole('main')).toBeNull()
  })
})

// ── review 473: autoFocus at the first step (F1), Escape in a text field (H1, Anton 29.10.) ──────

function Field() {
  return (
    <FlowPage title="Unlock">
      <input aria-label="Password" autoFocus />
    </FlowPage>
  )
}

/** a flow in a moving host, as the gate renders the identity flows */
function Hosted({ wide, slot }: { wide: boolean; slot: 'a' | 'b' }) {
  const { host, placed, place } = usePortalHost()
  return (
    <>
      {placed
        ? createPortal(
            <PageFrame variant="standalone" wide={wide} onEscape={() => undefined}>
              <Field />
            </PageFrame>,
            host,
          )
        : null}
      {slot === 'a' ? <div data-testid="a" ref={place} /> : <section data-testid="b" ref={place} />}
    </>
  )
}

describe('focus and Escape in fields', () => {
  for (const wide of [false, true]) {
    it(`${wide ? 'desktop' : 'phone'}: the first step's autoFocus takes in a moving host (F1)`, async () => {
      render(
        <LanguageProvider lang="en">
          <Hosted wide={wide} slot="a" />
        </LanguageProvider>,
      )
      await waitFor(() => expect(screen.getByLabelText('Password')).toHaveFocus())
    })
  }

  it('the host moves to another slot without a remount: the typed value stays', async () => {
    const { rerender } = render(
      <LanguageProvider lang="en">
        <Hosted wide slot="a" />
      </LanguageProvider>,
    )
    const field = await screen.findByLabelText('Password')
    fireEvent.change(field, { target: { value: 'correct horse' } })
    rerender(
      <LanguageProvider lang="en">
        <Hosted wide slot="b" />
      </LanguageProvider>,
    )
    expect(screen.getByTestId('b')).toContainElement(screen.getByLabelText('Password'))
    expect(screen.getByLabelText('Password')).toHaveValue('correct horse')
  })

  it('Escape in a non-empty text field keeps the field; in an empty one, it is back', async () => {
    const onEscape = vi.fn()
    render(
      <LanguageProvider lang="en">
        <PageFrame variant="standalone" wide onEscape={onEscape}>
          <Field />
        </PageFrame>
      </LanguageProvider>,
    )
    const field = await screen.findByLabelText('Password')
    fireEvent.change(field, { target: { value: 'correct horse' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(onEscape).not.toHaveBeenCalled()
    expect(field).toHaveValue('correct horse')
    fireEvent.change(field, { target: { value: '' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(onEscape).toHaveBeenCalledTimes(1)
  })

  it('keepsEscape: text with content keeps it; buttons, checkboxes and empty fields do not', () => {
    const text = document.createElement('input')
    text.value = 'x'
    const box = document.createElement('input')
    box.type = 'checkbox'
    expect([keepsEscape(text), keepsEscape(box), keepsEscape(document.createElement('textarea')), keepsEscape(null)]).toEqual([true, false, false, false])
  })
})

// ── through the app: the gate and the shell decide the frame ─────────────────────────────────────

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

const nav = () => screen.getAllByRole('navigation', { name: 'Main navigation' })

describe('frames through the app', () => {
  it('onboarding keeps its words when the phone turns to landscape and back (no new identity drawn)', async () => {
    const vp = viewport(false)
    try {
      render(<App composition={await composeIdentityScenario(freshInstall)} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Create identity' }))
      const words = async () => [...(await screen.findByRole('list', { name: 'Your 12 Magic Words' })).querySelectorAll('li')].map((li) => li.textContent)
      const before = await words()
      vp.set(true)
      expect(await words()).toEqual(before)
      vp.set(false)
      expect(await words()).toEqual(before)
      expect(screen.queryByRole('dialog')).toBeNull()
    } finally {
      vp.restore()
    }
  })

  it('desktop: unlock is a whole page without navigation, the password field has the focus', async () => {
    const vp = viewport(true)
    try {
      render(<App composition={await composeIdentityScenario(locked)} />)
      await waitFor(() => expect(screen.getByLabelText('Password', { exact: true })).toHaveFocus())
      expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull()
      expect(screen.queryByRole('dialog')).toBeNull()
      // no header bar above it (Anton 29.10.)
      expect(screen.queryByRole('banner')).toBeNull()
    } finally {
      vp.restore()
    }
  })

  it('desktop: verify is a page in the content column with the sidebar; Escape is back to the conversation', async () => {
    const vp = viewport(true)
    try {
      const comp = composeScenario(iiw, { open: 'c:marcus' as ConversationKey })
      render(<App composition={comp} />)
      await screen.findByText('Marcus Chen verified you', { exact: true })
      fireEvent.click(screen.getAllByRole('button', { name: 'Verify in person' })[0] as HTMLElement)
      const page = await screen.findByRole('region', { name: 'Verify in person' })
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(document.querySelector('[inert]')).toBeNull()
      expect(nav().length).toBeGreaterThan(0)
      // no columns while the ceremony runs: the conversation is not beside it
      expect(screen.queryByText('Marcus Chen verified you', { exact: true })).toBeNull()
      // a click on the page beside its controls does not end it
      fireEvent.pointerDown(page)
      fireEvent.click(page)
      expect(screen.getByRole('region', { name: 'Verify in person' })).toBeInTheDocument()
      await act(async () => undefined)
      fireEvent.keyDown(page, { key: 'Escape' })
      expect(await screen.findByText('Marcus Chen verified you', { exact: true })).toBeInTheDocument()
      expect(screen.queryByRole('region', { name: 'Verify in person' })).toBeNull()
    } finally {
      vp.restore()
    }
  })

  it('a question is a dialog over the columns; the sidebar stays', async () => {
    const vp = viewport(true)
    try {
      render(<App composition={composeScenario(iiw, { open: 'c:marcus' as ConversationKey })} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Respond' }))
      const dialog = await screen.findByRole('dialog')
      expect(dialog).toHaveAttribute('aria-modal', 'true')
      expect(within(dialog).getByRole('heading', { name: /Marcus/ })).toBeInTheDocument()
    } finally {
      vp.restore()
    }
  })

  it('without content no second column: an empty list carries “Verify in person” itself, never “pick a conversation”', async () => {
    const vp = viewport(true)
    try {
      render(<App composition={composeScenario(empty)} />)
      expect(await screen.findByText('No contacts yet')).toBeInTheDocument()
      expect(screen.queryByText('Pick a conversation on the left.')).toBeNull()
      expect(screen.getAllByRole('button', { name: 'Verify in person' })).toHaveLength(1)
      fireEvent.click(within(nav()[0] as HTMLElement).getByRole('button', { name: /Groups/ }))
      expect(await screen.findByText('This area follows in a later step.')).toBeInTheDocument()
      expect(screen.queryByText('Pick a conversation on the left.')).toBeNull()
    } finally {
      vp.restore()
    }
  })

  it('phone: the empty list keeps its footer action (as before)', async () => {
    const vp = viewport(false)
    try {
      render(<App composition={composeScenario(empty)} />)
      expect(await screen.findByText('No contacts yet')).toBeInTheDocument()
      expect(screen.getAllByRole('button', { name: 'Verify in person' })).toHaveLength(1)
    } finally {
      vp.restore()
    }
  })
})

describe('identity flows of the open app are pages with the sidebar', () => {
  const unlocked = { ...locked, identity: { state: 'unlocked' as const, protection: 'passphrase' as const } }

  it('protection change: a page beside the sidebar; Escape in the typed password keeps it, on the empty field it closes', async () => {
    const vp = viewport(true)
    try {
      render(<App composition={await composeIdentityScenario(unlocked)} />)
      fireEvent.click((await screen.findAllByRole('button', { name: 'Profile' }))[0] as HTMLElement)
      fireEvent.click(await screen.findByRole('button', { name: /^Protection/ }))
      expect(nav().length).toBeGreaterThan(0)
      fireEvent.click(await screen.findByRole('button', { name: /Password and biometrics/ }))
      const field = await screen.findByLabelText('Password', { exact: true })
      fireEvent.change(field, { target: { value: 'correct horse' } })
      fireEvent.keyDown(field, { key: 'Escape' })
      await act(async () => new Promise((r) => setTimeout(r, 10)))
      expect(screen.getByLabelText('Password', { exact: true })).toHaveValue('correct horse')
      fireEvent.change(field, { target: { value: '' } })
      fireEvent.keyDown(field, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByLabelText('Password', { exact: true })).not.toBeInTheDocument())
    } finally {
      vp.restore()
    }
  })

  it('a page in the shell keeps what was typed when the window crosses the breakpoint', async () => {
    const vp = viewport(true)
    try {
      render(<App composition={await composeIdentityScenario(unlocked)} />)
      fireEvent.click((await screen.findAllByRole('button', { name: 'Profile' }))[0] as HTMLElement)
      fireEvent.click(await screen.findByRole('button', { name: /^Protection/ }))
      fireEvent.click(await screen.findByRole('button', { name: /Password and biometrics/ }))
      fireEvent.change(await screen.findByLabelText('Password', { exact: true }), { target: { value: 'correct horse' } })
      vp.set(false)
      expect(screen.getByLabelText('Password', { exact: true })).toHaveValue('correct horse')
      vp.set(true)
      expect(screen.getByLabelText('Password', { exact: true })).toHaveValue('correct horse')
    } finally {
      vp.restore()
    }
  })

  it('another area in the sidebar ends the identity page', async () => {
    const vp = viewport(true)
    try {
      render(<App composition={await composeIdentityScenario(unlocked)} />)
      fireEvent.click((await screen.findAllByRole('button', { name: 'Profile' }))[0] as HTMLElement)
      fireEvent.click(await screen.findByRole('button', { name: /^Protection/ }))
      await screen.findByRole('button', { name: /Password and biometrics/ })
      fireEvent.click(screen.getAllByRole('button', { name: /^Contacts/ })[0] as HTMLElement)
      await waitFor(() => expect(screen.queryByRole('button', { name: /Password and biometrics/ })).toBeNull())
      expect(await screen.findByRole('heading', { name: 'Contacts' })).toBeInTheDocument()
    } finally {
      vp.restore()
    }
  })

  it('the sidebar asks the flow: before the delete is confirmed it leaves; from the confirmation on it holds (review 481 B1)', async () => {
    const vp = viewport(true)
    try {
      const comp = await composeIdentityScenario(unlocked)
      render(<App composition={comp} />)
      const contacts = () => screen.getAllByRole('button', { name: /^Contacts/ })[0] as HTMLElement
      fireEvent.click((await screen.findAllByRole('button', { name: 'Profile' }))[0] as HTMLElement)
      fireEvent.click(await screen.findByRole('button', { name: 'Delete identity' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
      fireEvent.change(screen.getByLabelText('Confirmation'), { target: { value: 'delete' } })
      fireEvent.click(within(screen.getByRole('region', { name: 'Delete identity' })).getByRole('button', { name: 'Delete identity' }))
      // the machine is in quiescing now (locked): another area must not cut the delete in half
      fireEvent.click(contacts())
      expect(await screen.findByText('Deleted on this device')).toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: 'Contacts' })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Done' }))
      expect(await screen.findByRole('button', { name: 'Create identity' })).toBeInTheDocument()
    } finally {
      vp.restore()
    }
  })

  it('opening and closing an identity page keeps the shell: the focus returns to the same “Protection” row (review 481 B2)', async () => {
    const vp = viewport(true)
    try {
      render(<App composition={await composeIdentityScenario(unlocked)} />)
      fireEvent.click((await screen.findAllByRole('button', { name: 'Profile' }))[0] as HTMLElement)
      const change = await screen.findByRole('button', { name: /^Protection/ })
      change.focus()
      fireEvent.click(change)
      await screen.findByRole('button', { name: /Password and biometrics/ })
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
      await waitFor(() => expect(screen.queryByRole('button', { name: /Password and biometrics/ })).toBeNull())
      expect(screen.getByRole('button', { name: /^Protection/ })).toBe(change)
      await waitFor(() => expect(document.activeElement).toBe(change))
    } finally {
      vp.restore()
    }
  })

  it('delete: a page with the sidebar while the identity is open, then without it; the flow runs to its end (no restart)', async () => {
    const vp = viewport(true)
    try {
      const comp = await composeIdentityScenario(unlocked)
      render(<App composition={comp} />)
      fireEvent.click((await screen.findAllByRole('button', { name: 'Profile' }))[0] as HTMLElement)
      fireEvent.click(await screen.findByRole('button', { name: 'Delete identity' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
      expect(nav().length).toBeGreaterThan(0)
      fireEvent.change(screen.getByLabelText('Confirmation'), { target: { value: 'delete' } })
      fireEvent.click(within(screen.getByRole('region', { name: 'Delete identity' })).getByRole('button', { name: 'Delete identity' }))
      expect(await screen.findByText('Deleted on this device')).toBeInTheDocument()
      expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Done' }))
      expect(await screen.findByRole('button', { name: 'Create identity' })).toBeInTheDocument()
    } finally {
      vp.restore()
    }
  })
})
