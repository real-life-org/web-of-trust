import type { TrustState, Verification } from '../../port'
import { useI18n } from '../../i18n'
import { cn } from '../primitives'
import { ChevronLeftIcon, ChevronRightIcon } from './icons'
import { PersonAvatar } from './PersonAvatar'
import { BLOCKED_GLYPH, TRUST_GLYPH, VERIFICATION_GLYPH, trustKind } from './glyphs'

export interface ChatHeaderProps {
  name: string
  verification?: Verification
  trust?: TrustState
  blocked?: boolean
  onBack?: () => void
  onDetails?: () => void
}

/** Conversation head: back (mobile only), avatar, name, verification and trust line, chevron to details. */
export function ChatHeader({ name, verification, trust, blocked, onBack, onDetails }: ChatHeaderProps) {
  const { t } = useI18n()
  const tk = trust ? trustKind(trust) : null
  return (
    <header className="flex flex-none items-center gap-1 border-b border-border bg-[color-mix(in_oklab,var(--card)_85%,transparent)] px-2.5 py-2 backdrop-blur-md">
      <button
        type="button"
        onClick={onBack}
        aria-label={t.nav.back}
        className="hit-target relative flex size-9 flex-none items-center justify-center rounded-md text-foreground hover:bg-muted md:hidden"
      >
        <ChevronLeftIcon className="size-5" />
      </button>
      {/* the page title (h1) for headings navigation; visibly the name sits in the details button,
          which cannot hold a heading */}
      <h1 className="sr-only">{name}</h1>
      <button
        type="button"
        onClick={onDetails}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1.5 py-1 text-left text-inherit hover:bg-muted"
      >
        <PersonAvatar name={name} size={38} dashed={verification === 'introduced'} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[15px] font-semibold">{name}</span>
          <span className="flex gap-2 overflow-hidden text-xs whitespace-nowrap">
            {verification ? (
              <span className={cn(verification === 'introduced' ? 'text-warning-strong' : 'text-primary')}>
                {VERIFICATION_GLYPH[verification]} {t.verification[verification]}
              </span>
            ) : null}
            {blocked ? (
              <span className="text-muted-foreground">
                {BLOCKED_GLYPH} {t.block.badge}
              </span>
            ) : tk ? (
              <span className="text-success-strong">
                {TRUST_GLYPH[tk]} {t.trust[tk]}
              </span>
            ) : null}
          </span>
        </span>
        {/* the name is the visible text plus this word (WCAG 2.5.3 label in name) */}
        <span className="sr-only">, {t.nav.details}</span>
        <ChevronRightIcon className="size-4 flex-none text-[color-mix(in_oklab,var(--muted-foreground)_50%,transparent)]" />
      </button>
    </header>
  )
}
