interface AvatarProps {
  name?: string | undefined
  avatar?: string | undefined
  size?: 'xs' | 'sm' | 'md' | 'lg'
}

const sizeClasses = {
  xs: 'w-8 h-8 text-xs',
  sm: 'w-10 h-10 text-sm',
  md: 'w-14 h-14 text-lg',
  lg: 'w-20 h-20 text-2xl',
}

const colors = [
  'bg-primary-100 text-primary-700',
  'bg-accent-100 text-accent-600',
  'bg-amber-100 text-amber-700',
  'bg-success/15 text-success',
  'bg-orange-100 text-orange-700',
  'bg-teal-100 text-teal-700',
  'bg-rose-100 text-rose-700',
  'bg-muted text-muted-foreground',
]

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  }
  return name.trim().slice(0, 2).toUpperCase()
}

function getColorIndex(name: string): number {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  return Math.abs(hash) % colors.length
}

export function Avatar({ name, avatar, size = 'md' }: AvatarProps) {
  const sizeClass = sizeClasses[size]

  if (avatar) {
    return (
      <img
        src={avatar}
        alt={name || 'Avatar'}
        draggable={false}
        className={`${sizeClass} rounded-full object-cover flex-shrink-0`}
      />
    )
  }

  if (name && name.trim()) {
    const initials = getInitials(name)
    const colorClass = colors[getColorIndex(name)]
    return (
      <div className={`${sizeClass} ${colorClass} rounded-full flex items-center justify-center flex-shrink-0 font-semibold`}>
        {initials}
      </div>
    )
  }

  return (
    <div className={`${sizeClass} bg-muted text-muted-foreground/70 rounded-full flex items-center justify-center flex-shrink-0 font-semibold`}>
      ?
    </div>
  )
}
