// A link inside running text: always underlined, so it is told apart from the text by more than
// color (WCAG 1.4.1, axe link-in-text-block). A link that stands alone is a Button variant="link".
import type * as React from 'react'
import { cn } from './utils'

export function TextLink({ className, ...props }: React.ComponentProps<'a'>) {
  return <a data-slot="text-link" className={cn('text-primary underline underline-offset-2', className)} {...props} />
}
