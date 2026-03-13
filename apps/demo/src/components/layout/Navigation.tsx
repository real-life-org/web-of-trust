import { NavLink, useNavigate, useLocation } from 'react-router-dom'
import { Fingerprint, Users, UserPlus, QrCode, Award, Home, Boxes } from 'lucide-react'
import { useLanguage } from '../../i18n'

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
