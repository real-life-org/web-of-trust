import * as React from 'react'
import { cn } from './utils'

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none transition-[box-shadow,border-color]',
        'placeholder:text-muted-foreground focus-visible:border-transparent focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
