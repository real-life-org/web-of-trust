// Icons of the design prototype, inlined with their exact paths (lucide geometry).
import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

export function ContactsIcon(p: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...stroke} {...p}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

/** The network symbol: groups tab and logo. */
export function NetworkIcon({ filled, ...p }: IconProps & { filled?: boolean }) {
  return (
    <svg viewBox={filled ? '0 1 23 22' : '0 0 24 24'} aria-hidden {...stroke} fill={filled ? 'currentColor' : 'none'} {...p}>
      <circle cx="18.72" cy="8.82" r="2.5" />
      <circle cx="5.28" cy="5.28" r="2.5" />
      <circle cx="8.82" cy="18.72" r="2.5" />
      <line x1="6.04" x2="8.06" y1="8.18" y2="15.82" />
      <line x1="15.81" x2="8.18" y1="8.05" y2="6.04" />
      <line x1="16.59" x2="10.94" y1="10.94" y2="16.59" />
    </svg>
  )
}

export function ProfileIcon(p: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...stroke} {...p}>
      <circle cx="12" cy="8" r="5" />
      <path d="M20 21a8 8 0 0 0-16 0" />
    </svg>
  )
}

export function VerifyIcon(p: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...stroke} {...p}>
      <path d="m18 8 4 4-4 4" />
      <path d="M2 12h20" />
      <path d="m6 8-4 4 4 4" />
    </svg>
  )
}

export function PlusIcon(p: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...stroke} {...p}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  )
}

export function PersonIcon(p: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...stroke} {...p}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
    </svg>
  )
}

export function ChevronLeftIcon(p: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...stroke} {...p}>
      <path d="m15 18-6-6 6-6" />
    </svg>
  )
}

export function ChevronRightIcon(p: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...stroke} {...p}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

export function SendIcon(p: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...stroke} {...p}>
      <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
      <path d="m21.854 2.147-10.94 10.939" />
    </svg>
  )
}
