import type { ReactNode } from 'react'
import { Button } from '../primitives'

/** The primary action pinned under a list (design: "Verify in person", "Found a group"). */
export function FooterAction({ icon, label, onClick }: { icon: ReactNode; label: string; onClick?: () => void }) {
  return (
    <div className="flex-none border-t border-border bg-background px-4 pt-2.5 pb-3">
      <Button size="lg" className="w-full [&_svg]:size-[18px]" onClick={onClick}>
        {icon}
        {label}
      </Button>
    </div>
  )
}
