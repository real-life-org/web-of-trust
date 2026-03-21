import { Outlet, useLocation } from 'react-router-dom'
import { Navigation } from './Navigation'

const FULLSCREEN_ROUTES = ['/network']

export function AppShell() {
  const { pathname } = useLocation()
  const fullscreen = FULLSCREEN_ROUTES.some(r => pathname.startsWith(r))

  return (
    <div className={fullscreen ? 'h-[100dvh] flex flex-col md:flex-row' : 'min-h-screen flex flex-col md:flex-row'}>
      <Navigation />
      {fullscreen ? (
        <main className="flex-1 pb-16 md:pb-0 overflow-hidden">
          <Outlet />
        </main>
      ) : (
        <main className="flex-1 pb-20 md:pb-0 overflow-auto">
          <div className="max-w-2xl mx-auto p-4 md:p-8">
            <Outlet />
          </div>
        </main>
      )}
    </div>
  )
}
