import { Avatar, AvatarFallback, AvatarImage, cn } from '../primitives'
import { initials, paletteIndex } from './avatar-color'

const SIZES = {
  32: 'size-8 text-xs',
  38: 'size-[38px] text-sm',
  44: 'size-11 text-[15px]',
  56: 'size-14 text-lg',
} as const

export interface PersonAvatarProps {
  name: string
  image?: string | null
  size?: keyof typeof SIZES
  /** groups use a rounded square */
  shape?: 'circle' | 'square'
  /** introduced contacts: dashed amber border (design ◇) */
  dashed?: boolean
  className?: string
}

/** Initials avatar in the prototype's palette; decorative, the name stands next to it. */
export function PersonAvatar({ name, image, size = 44, shape = 'circle', dashed, className }: PersonAvatarProps) {
  const n = paletteIndex(name)
  return (
    <Avatar
      aria-hidden
      className={cn(
        SIZES[size],
        shape === 'square' ? (size >= 44 ? 'rounded-lg' : 'rounded-md') : 'rounded-full',
        dashed && 'border border-dashed border-[color-mix(in_oklab,var(--warning)_60%,var(--border))]',
        className,
      )}
      style={{ background: `var(--avatar-${n}-bg)`, color: `var(--avatar-${n}-fg)` }}
    >
      {image ? <AvatarImage src={image} alt="" /> : null}
      <AvatarFallback>{initials(name)}</AvatarFallback>
    </Avatar>
  )
}
