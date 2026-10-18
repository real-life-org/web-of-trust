// Radix Switch: role="switch" + aria-checked (architecture §6.5). 40 × 24 px as in the design.
import * as React from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import { cn } from './utils'

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'inline-flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
        'bg-[color-mix(in_oklab,var(--muted-foreground)_35%,transparent)] data-[state=checked]:bg-success disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-4" />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
