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
  'bg-purple-100 text-purple-600',
  'bg-blue-100 text-blue-600',
  'bg-green-100 text-green-600',
  'bg-amber-100 text-amber-600',
  'bg-rose-100 text-rose-600',
  'bg-teal-100 text-teal-600',
  'bg-indigo-100 text-indigo-600',
  'bg-orange-100 text-orange-600',
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
    <div className={`${sizeClass} bg-slate-100 text-slate-400 rounded-full flex items-center justify-center flex-shrink-0 font-semibold`}>
      ?
    </div>
  )
}
