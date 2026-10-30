import type { ReactNode } from 'react'
import { cn } from '../primitives'

/** An area with nothing in it yet. `alone`: the area is the only column (desktop, canvas "Leer"): no
 *  frame, centered in the column, with the area's action in it instead of under the list. */
export function EmptyState({ icon, title, body, action, alone = false }: { icon: ReactNode; title: string; body: string; action?: ReactNode; alone?: boolean }) {
  return (
    <div
      className={cn(
        'flex flex-none flex-col items-center gap-2 text-center',
        alone ? 'my-auto py-10' : 'rounded-xl border border-dashed border-border px-5 py-10',
      )}
    >
      <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-[22px]">
        {icon}
      </span>
      <div className="text-[17px] font-semibold">{title}</div>
      <p className="m-0 max-w-[36ch] text-sm text-pretty text-muted-foreground">{body}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}
