/**
 * App-wide "connect" FAB in AppShell (mobile only). Verifies the route-matching
 * visibility rules: shown on ordinary pages, hidden on /verify and the chat-detail
 * route (SpaceDetail composer collision), but kept on the /chats/new create form.
 * Renders the real AppShell inside a MemoryRouter (pattern: AppRoutes.test).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { LanguageProvider } from '../src/i18n'
import { AppShell } from '../src/components/layout/AppShell'

// German aria-label for the FAB (t.nav.verify). Reused, no new i18n key.
const FAB_LABEL = 'Verbinden'

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('wot-language', 'de') // deterministic copy (LanguageProvider reads it at mount)
})

function renderAt(path: string) {
  return render(
    <LanguageProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<div>home</div>} />
            <Route path="/contacts" element={<div>contacts</div>} />
            <Route path="/attestations/*" element={<div>attestations</div>} />
            <Route path="/identity" element={<div>identity</div>} />
            <Route path="/verify" element={<div>verify</div>} />
            <Route path="/chats/*" element={<div>chats</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </LanguageProvider>,
  )
}

describe('AppShell connect FAB', () => {
  // /chats/new and /chats/:id/edit are SpaceForm routes without a composer —
  // only the chat-detail route itself hides the FAB.
  it.each(['/', '/contacts', '/attestations', '/identity', '/chats', '/chats/new', '/chats/abc123/edit'])(
    'renders the FAB on %s',
    (path) => {
      renderAt(path)
      const fab = screen.getByRole('button', { name: FAB_LABEL })
      expect(fab).toBeInTheDocument()
      // Mobile-only + not overlapping the nav (inset-aware bottom offset).
      expect(fab.className).toContain('md:hidden')
      expect(fab.className).toContain('bottom-[calc(6rem+var(--safe-bottom))]')
    },
  )

  it.each(['/verify', '/chats/abc123', '/chats/z6MkSpaceId'])(
    'hides the FAB on %s',
    (path) => {
      renderAt(path)
      expect(screen.queryByRole('button', { name: FAB_LABEL })).not.toBeInTheDocument()
    },
  )

  it('navigates to /verify when the FAB is clicked', async () => {
    render(
      <LanguageProvider>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/" element={<div>home-page</div>} />
              <Route path="/verify" element={<div>verify-page</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </LanguageProvider>,
    )
    expect(screen.getByText('home-page')).toBeInTheDocument()
    screen.getByRole('button', { name: FAB_LABEL }).click()
    expect(await screen.findByText('verify-page')).toBeInTheDocument()
  })
})
