import type { ReactNode } from 'react'
import { useI18n } from '../../i18n'
import { cn } from '../primitives'
import { NetworkIcon } from './icons'

export interface NavItem {
  id: string
  label: string
  icon: ReactNode
  active: boolean
  badge: number
  onSelect: () => void
}

/** Mobile bottom bar with three tabs (design: isMobile). */
export function BottomNav({ items }: { items: readonly NavItem[] }) {
  const { t } = useI18n()
  return (
    <nav
      aria-label={t.nav.primary}
      className="grid flex-none grid-cols-3 border-t border-border bg-card pb-[var(--safe-bottom)] md:hidden"
    >
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          onClick={it.onSelect}
          aria-current={it.active ? 'page' : undefined}
          className={cn(
            'relative flex flex-col items-center gap-[3px] border-none bg-transparent pt-2.5 pb-2 text-[11px] font-medium',
            it.active ? 'text-primary' : 'text-muted-foreground',
          )}
        >
          <span className="flex size-[22px] [&_svg]:size-[22px]">{it.icon}</span>
          {it.label}
          {it.badge > 0 ? (
            <span className="absolute top-[7px] left-[calc(50%+6px)] flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 text-[10px] font-bold text-white">
              {it.badge}
            </span>
          ) : null}
        </button>
      ))}
    </nav>
  )
}

/** Desktop sidebar with logo and tabs (design: isDesktop). */
export function SideNav({ items, appName }: { items: readonly NavItem[]; appName: string }) {
  const { t } = useI18n()
  return (
    <nav
      aria-label={t.nav.primary}
      className="hidden w-[232px] flex-none flex-col gap-1 border-r border-border bg-card px-3 py-4 md:flex"
    >
      <div className="flex items-center gap-2.5 px-2.5 pt-1.5 pb-[18px]">
        <span className="flex size-8 flex-none items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <NetworkIcon filled className="size-[18px]" />
        </span>
        <span className="text-[15px] font-bold">{appName}</span>
      </div>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          onClick={it.onSelect}
          aria-current={it.active ? 'page' : undefined}
          className={cn(
            'flex items-center gap-3 rounded-lg border-none px-3 py-2.5 text-left text-sm font-medium',
            it.active ? 'bg-[color-mix(in_oklab,var(--primary)_10%,transparent)] text-primary' : 'bg-transparent text-muted-foreground',
          )}
        >
          <span className="flex size-5 flex-none [&_svg]:size-5">{it.icon}</span>
          <span className="flex-1">{it.label}</span>
          {it.badge > 0 ? (
            <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--warning)_18%,transparent)] px-[5px] text-[11px] font-semibold text-warning-strong">
              {it.badge}
            </span>
          ) : null}
        </button>
      ))}
    </nav>
  )
}
