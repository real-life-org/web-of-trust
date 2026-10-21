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

// ── Identity (lucide geometry) ──────────────────────────────────────────────

export function LockIcon(p: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...stroke} {...p}>
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  )
}

export function FingerprintIcon(p: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...stroke} {...p}>
      <path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4" />
      <path d="M14 13.12c0 2.38 0 6.38-1 8.88" />
      <path d="M17.29 21.02c.12-.6.43-2.3.5-3.02" />
      <path d="M2 12a10 10 0 0 1 18-6" />
      <path d="M2 16h.01" />
      <path d="M21.8 16c.2-2 .131-5.354 0-6" />
      <path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2" />
      <path d="M8.65 22c.21-.66.45-1.32.57-2" />
      <path d="M9 6.8a6 6 0 0 1 9 5.2v2" />
    </svg>
  )
}

export function KeyIcon(p: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...stroke} {...p}>
      <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
      <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
    </svg>
  )
}

export function ShieldIcon(p: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...stroke} {...p}>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    </svg>
  )
}

export function AlertIcon(p: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...stroke} {...p}>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  )
}

export function EyeIcon(p: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...stroke} {...p}>
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

export function EyeOffIcon(p: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...stroke} {...p}>
      <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
      <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
      <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
      <path d="m2 2 20 20" />
    </svg>
  )
}

export function CopyIcon(p: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...stroke} {...p}>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  )
}

export function CheckIcon(p: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...stroke} {...p}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

export function CloseIcon(p: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...stroke} {...p}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

export function TrashIcon(p: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...stroke} {...p}>
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
      <line x1="10" x2="10" y1="11" y2="17" />
      <line x1="14" x2="14" y1="11" y2="17" />
    </svg>
  )
}

/** Scan frame (prototype "Code scannen"). */
export function ScanIcon(p: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...stroke} {...p}>
      <path d="M3 7V5a2 2 0 0 1 2-2h2" />
      <path d="M17 3h2a2 2 0 0 1 2 2v2" />
      <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
      <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
      <path d="M7 12h10" />
    </svg>
  )
}

export function CameraIcon(p: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...stroke} {...p}>
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
      <circle cx="12" cy="13" r="3" />
    </svg>
  )
}

export function KeyboardIcon(p: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...stroke} {...p}>
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10" />
    </svg>
  )
}
