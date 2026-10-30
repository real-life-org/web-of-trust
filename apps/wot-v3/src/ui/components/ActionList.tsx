// A card of row actions, as in Signal's settings and details (Anton 29.10.: buttons in a card look
// cheap): one row per action, an icon and a label, the whole row is the button. Destructive actions
// are red and go in a card of their own. One component for this meaning (gemeinsame Dialog-Familie).
import type { ReactNode } from 'react'
import { cn } from '../primitives'

export interface ActionRow {
  readonly icon: ReactNode
  readonly label: string
  readonly onClick: () => void
  /** right-aligned value (Signal: "On", a count, the current protection) */
  readonly value?: string | null
  readonly tone?: 'default' | 'destructive'
}

export function ActionList({ rows, label }: { rows: readonly ActionRow[]; label?: string }) {
  if (rows.length === 0) return null
  return (
    <ul aria-label={label} className="m-0 flex list-none flex-col overflow-hidden rounded-xl border border-border bg-card p-1.5">
      {rows.map((r) => (
        <li key={r.label}>
          <button
            type="button"
            onClick={r.onClick}
            className={cn(
              'flex min-h-11 w-full items-center gap-3.5 rounded-lg px-3 py-2.5 text-left text-[15px] hover:bg-muted focus-visible:bg-muted [&_svg]:size-[18px] [&_svg]:flex-none [&_svg]:stroke-[1.75]',
              r.tone === 'destructive' ? 'text-destructive-strong' : 'text-foreground',
            )}
          >
            {r.icon}
            <span className="min-w-0 flex-1 truncate">{r.label}</span>
            {r.value ? <span className="flex-none text-sm text-muted-foreground">{r.value}</span> : null}
          </button>
        </li>
      ))}
    </ul>
  )
}
