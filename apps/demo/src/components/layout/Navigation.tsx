import { NavLink } from 'react-router-dom'
import { Fingerprint, Users, UserPlus, Award, Home, MessageCircle } from 'lucide-react'
import { useLanguage } from '../../i18n'

export function Navigation() {
  const { t } = useLanguage()

  const mobileItems = [
    { to: '/', icon: Home, label: t.nav.home },
    { to: '/identity', icon: Fingerprint, label: t.nav.identity },
    { to: '/contacts', icon: Users, label: t.nav.contacts },
    { to: '/attestations', icon: Award, label: t.nav.attestations },
    { to: '/chats', icon: MessageCircle, label: t.nav.chats },
  ]

  const sidebarItems = [
    { to: '/', icon: Home, label: t.nav.home },
    { to: '/identity', icon: Fingerprint, label: t.nav.identity },
    { to: '/contacts', icon: Users, label: t.nav.contacts },
    { to: '/verify', icon: UserPlus, label: t.nav.verify },
    { to: '/chats', icon: MessageCircle, label: t.nav.chats },
    { to: '/attestations', icon: Award, label: t.nav.attestations },
    // Kein eigener Graph-Menüpunkt mehr: der Graph lebt als Tab in Kontakte.
    // Die /network-Route bleibt für den Beamer-Fullscreen direkt erreichbar.
  ]

  // Mobile bottom nav keeps its 1rem visual gap AND clears the Android system nav
  // bar (edge-to-edge) via the safe-area inset. The inset lives on the nav, not on
  // page padding, because <main> and <nav> are flex siblings in AppShell.
  return (
      <nav className="shrink-0 bg-card border-t border-border pb-[calc(1rem+var(--safe-bottom))] md:pb-0 md:border-t-0 md:border-r md:h-auto md:w-64 md:order-first md:overflow-auto">
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
        <ul className="grid grid-cols-5 md:hidden">
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
  )
}
