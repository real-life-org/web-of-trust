import { Outlet, useLocation, useMatch, useNavigate } from 'react-router-dom'
import { UserPlus } from 'lucide-react'
import { Navigation } from './Navigation'
import { useLanguage } from '../../i18n'

const FULLSCREEN_ROUTES = ['/network']

export function AppShell() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const { t } = useLanguage()
  const fullscreen = FULLSCREEN_ROUTES.some(r => pathname.startsWith(r))

  // App-wide "connect" FAB (mobile only). Hidden where it would collide:
  // - /verify (its own target)
  // - the chat-detail route (SpaceDetail's message composer). `/chats/:spaceId`
  //   matches /chats/new too, so keep the FAB on the create form by excluding it.
  const spaceMatch = useMatch('/chats/:spaceId')
  const onChatDetail = !!spaceMatch && spaceMatch.params.spaceId !== 'new'
  const hideConnectFab = pathname.startsWith('/verify') || onChatDetail

  return (
    <div className="flex-1 flex flex-col md:flex-row min-h-0">
      {fullscreen ? (
        <main className="flex-1 overflow-hidden md:order-2 relative">
          <Outlet />
        </main>
      ) : (
        <main className="flex-1 overflow-auto md:order-2 relative">
          <div className="max-w-2xl mx-auto p-4 md:p-8">
            <Outlet />
          </div>
        </main>
      )}
      {!hideConnectFab && (
        <button
          onClick={() => navigate('/verify')}
          aria-label={t.nav.verify}
          /* Sits above the bottom nav + system nav bar (safe-area inset) with the
             SAME visual gap as right-4: the mobile nav is ~78px tall (py-3 items:
             24px + icon 20px + gap 4px + 11px label ≈ 62px, plus 1rem base
             padding), so 6rem (96px) leaves ~1rem of air — 5rem sat flush on the
             bar. Calm: subtle active-state only, no scale/bounce (CLAUDE.md). */
          className="md:hidden fixed right-4 bottom-[calc(6rem+var(--safe-bottom))] z-40 w-14 h-14 rounded-full bg-primary text-primary-foreground shadow-lg flex items-center justify-center transition-colors hover:bg-primary/90 active:bg-primary/80"
        >
          <UserPlus size={24} />
        </button>
      )}
      <Navigation />
    </div>
  )
}
