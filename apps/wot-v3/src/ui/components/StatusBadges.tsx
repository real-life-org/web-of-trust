import type { TrustState, Verification } from '../../port'
import { useI18n } from '../../i18n'
import { cn } from '../primitives'
import { TRUST_GLYPH, VERIFICATION_GLYPH, trustKind } from './glyphs'

/** Verification pill: glyph plus word (design rowStyle "badges"). */
export function VerificationBadge({ verification, size = 'sm' }: { verification: Verification; size?: 'sm' | 'md' }) {
  const { t } = useI18n()
  const word = t.verification[verification]
  return (
    <span
      title={word}
      className={cn(
        'inline-flex shrink-0 items-center gap-[3px] whitespace-nowrap rounded-full font-medium leading-[1.4]',
        size === 'sm' ? 'px-[7px] py-px text-[11px]' : 'px-2.5 py-0.5 text-xs',
        verification === 'introduced'
          ? 'bg-[color-mix(in_oklab,var(--warning)_18%,transparent)] text-warning-strong'
          : 'bg-[color-mix(in_oklab,var(--primary)_12%,transparent)] text-primary',
      )}
    >
      <span aria-hidden>{VERIFICATION_GLYPH[verification]}</span>
      {word}
    </span>
  )
}

/** Trust pill: glyph only in rows, glyph plus word in details; the word is always the accessible name. */
export function TrustBadge({ trust, withWord = false }: { trust: TrustState; withWord?: boolean }) {
  const { t } = useI18n()
  const kind = trustKind(trust)
  if (kind === null) return null
  const word = t.trust[kind]
  return (
    <span
      title={word}
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--success)_15%,transparent)] px-[7px] py-px text-[11px] font-medium leading-[1.4] text-success"
    >
      <span aria-hidden>{TRUST_GLYPH[kind]}</span>
      {withWord ? word : <span className="sr-only">{word}</span>}
    </span>
  )
}
