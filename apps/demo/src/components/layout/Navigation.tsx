import { NavLink, useNavigate, useLocation } from 'react-router-dom'
import { Fingerprint, Users, UserPlus, QrCode, Award, Home, Boxes } from 'lucide-react'
import { useLanguage } from '../../i18n'

/** Phosphor "Graph" icon — matches the WoT network visualization better than lucide's Share2 */
function GraphIcon({ size = 20 }: { size?: number }) {
  const scaled = Math.round(size * 1.2)
  return (
    <svg width={scaled} height={scaled} viewBox="0 0 256 256" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M200,152a31.84,31.84,0,0,0-19.53,6.68l-23.11-18A31.65,31.65,0,0,0,160,128c0-.74,0-1.48-.08-2.21l13.23-4.41A32,32,0,1,0,168,104c0,.74,0,1.48.08,2.21l-13.23,4.41A32,32,0,0,0,128,96a32.59,32.59,0,0,0-5.27.44L115.89,81A32,32,0,1,0,96,88a32.59,32.59,0,0,0,5.27-.44l6.84,15.4a31.92,31.92,0,0,0-8.57,39.64L73.83,165.44a32.06,32.06,0,1,0,10.63,12l25.71-22.84a31.91,31.91,0,0,0,37.36-1.24l23.11,18A31.65,31.65,0,0,0,168,184a32,32,0,1,0,32-32Zm0-64a16,16,0,1,1-16,16A16,16,0,0,1,200,88ZM80,56A16,16,0,1,1,96,72,16,16,0,0,1,80,56ZM56,208a16,16,0,1,1,16-16A16,16,0,0,1,56,208Zm56-80a16,16,0,1,1,16,16A16,16,0,0,1,112,128Zm88,72a16,16,0,1,1,16-16A16,16,0,0,1,200,200Z" />
    </svg>
  )
}

export function Navigation() {
  const { t } = useLanguage()
  const navigate = useNavigate()
  const location = useLocation()

  const mobileItems = [
    { to: '/', icon: Home, label: t.nav.home },
    { to: '/identity', icon: Fingerprint, label: t.nav.identity },
    { to: '/contacts', icon: Users, label: t.nav.contacts },
    { to: '/attestations', icon: Award, label: t.nav.attestations },
  ]

  const sidebarItems = [
    { to: '/', icon: Home, label: t.nav.home },
    { to: '/identity', icon: Fingerprint, label: t.nav.identity },
    { to: '/contacts', icon: Users, label: t.nav.contacts },
    { to: '/verify', icon: UserPlus, label: t.nav.verify },
    { to: '/attestations', icon: Award, label: t.nav.attestations },
    { to: '/spaces', icon: Boxes, label: t.nav.spaces },
    { to: '/network', icon: GraphIcon, label: t.nav.network },
  ]

  return (
    <>
      {/* Mobile: Verify FAB — fixed bottom-right, above the nav bar */}
      <button
        onClick={() => navigate('/verify')}
        aria-label={t.nav.verify}
        className={`md:hidden fixed right-4 bottom-20 z-50 w-14 h-14 rounded-full shadow-lg flex items-center justify-center transition-colors ${
          location.pathname === '/verify'
            ? 'bg-primary text-primary-foreground'
            : 'bg-primary text-primary-foreground active:bg-primary/80'
        }`}
      >
        <QrCode size={24} />
      </button>

      <nav className="fixed bottom-0 left-0 right-0 z-40 bg-card border-t border-border md:sticky md:top-0 md:border-t-0 md:border-r md:h-screen md:w-64 md:shrink-0">
        {/* Desktop: show all items in sidebar */}
        <ul className="hidden md:flex md:flex-col md:p-4 md:gap-2">
          {sidebarItems.map(({ to, icon: Icon, label }) => (
            <li key={to}>
              <NavLink
                to={to}
                className={({ isActive }) =>
                  `flex flex-row items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
                    isActive
                      ? 'text-primary bg-primary/10'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                  }`
                }
              >
                <Icon size={20} />
                <span className="text-sm font-medium">{label}</span>
              </NavLink>
            </li>
          ))}
        </ul>

        {/* Mobile: 4 items (Spaces accessible from Home) */}
        <ul className="grid grid-cols-4 md:hidden">
          {mobileItems.map(({ to, icon: Icon, label }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={to === '/'}
                className={({ isActive }) =>
                  `flex flex-col items-center gap-1 py-3 transition-colors ${
                    isActive
                      ? 'text-primary'
                      : 'text-muted-foreground'
                  }`
                }
              >
                <Icon size={20} />
                <span className="text-[11px] font-medium leading-tight text-center">{label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </>
  )
}
