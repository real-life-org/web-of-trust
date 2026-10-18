// Radix Avatar: image with initials fallback. Colors come from the avatar tokens (--avatar-N-bg/fg).
import * as React from 'react'
import * as AvatarPrimitive from '@radix-ui/react-avatar'
import { cn } from './utils'

function Avatar({ className, ...props }: React.ComponentProps<typeof AvatarPrimitive.Root>) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      className={cn('relative flex size-11 shrink-0 select-none overflow-hidden rounded-full', className)}
      {...props}
    />
  )
}

function AvatarImage({ className, ...props }: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  return <AvatarPrimitive.Image className={cn('aspect-square size-full object-cover', className)} {...props} />
}

function AvatarFallback({ className, ...props }: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      className={cn('flex size-full items-center justify-center font-semibold', className)}
      {...props}
    />
  )
}

export { Avatar, AvatarImage, AvatarFallback }
