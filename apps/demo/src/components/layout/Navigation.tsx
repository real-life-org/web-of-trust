import { NavLink, useNavigate, useLocation } from 'react-router-dom'
import { Fingerprint, Users, QrCode, Award, Home, Boxes } from 'lucide-react'
import { useLanguage } from '../../i18n'

export function Navigation() {
  const { t } = useLanguage()
  const navigate = useNavigate()
  const location = useLocation()

  const navItems = [
    { to: '/', icon: Home, label: t.nav.home },
    { to: '/identity', icon: Fingerprint, label: t.nav.identity },
    { to: '/contacts', icon: Users, label: t.nav.contacts },
    { to: '/attestations', icon: Award, label: t.nav.attestations },
    { to: '/spaces', icon: Boxes, label: t.nav.spaces },
  ]

  const allItems = [
    ...navItems.slice(0, 3),
    { to: '/verify', icon: QrCode, label: t.nav.verify },
    ...navItems.slice(3),
  ]

  return (
    <>
      {/* Mobile: Verify FAB — fixed bottom-right, above the nav bar */}
      <button
        onClick={() => navigate('/verify')}
        className={`md:hidden fixed right-4 bottom-20 z-50 w-14 h-14 rounded-full shadow-lg flex items-center justify-center transition-colors ${
          location.pathname === '/verify'
            ? 'bg-primary-600 text-white'
            : 'bg-primary-500 text-white active:bg-primary-700'
        }`}
      >
        <QrCode size={24} />
      </button>

      <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 md:relative md:border-t-0 md:border-r md:h-screen md:w-64">
        {/* Desktop: show all items in sidebar */}
        <ul className="hidden md:flex md:flex-col md:p-4 md:gap-2">
          {allItems.map(({ to, icon: Icon, label }) => (
            <li key={to}>
              <NavLink
                to={to}
                className={({ isActive }) =>
                  `flex flex-row items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
                    isActive
                      ? 'text-primary-600 bg-primary-50'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                  }`
                }
              >
                <Icon size={20} />
                <span className="text-sm font-medium">{label}</span>
              </NavLink>
            </li>
          ))}
        </ul>

        {/* Mobile: 5 items */}
        <ul className="grid grid-cols-5 md:hidden">
          {navItems.map(({ to, icon: Icon, label }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={to === '/'}
                className={({ isActive }) =>
                  `flex flex-col items-center gap-1 py-3 transition-colors ${
                    isActive
                      ? 'text-primary-600'
                      : 'text-slate-600'
                  }`
                }
              >
                <Icon size={20} />
                <span className="text-[10px] font-medium leading-tight text-center">{label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </>
  )
}
