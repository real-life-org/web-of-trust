import type { ReactNode } from 'react'

export function EmptyState({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="flex flex-none flex-col items-center gap-2 rounded-xl border border-dashed border-border px-5 py-10 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-[22px]">
        {icon}
      </span>
      <div className="text-[17px] font-semibold">{title}</div>
      <p className="m-0 max-w-[36ch] text-sm text-pretty text-muted-foreground">{body}</p>
    </div>
  )
}
