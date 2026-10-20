// Status glyphs of the design. Never shown alone: every glyph has an accessible word next to it
// or as its label (architecture §6.5).
import type { Decision, SystemKind, TrustState, Verification } from '../../port'

export type Tone = 'primary' | 'success' | 'warning' | 'muted'

export const TONE_TEXT: Record<Tone, string> = {
  primary: 'text-primary',
  success: 'text-success',
  warning: 'text-warning-strong',
  muted: 'text-muted-foreground',
}

export const VERIFICATION_GLYPH: Record<Verification, string> = {
  mutual: '⇄',
  outgoing: '→',
  incoming: '←',
  introduced: '◇',
  met: '⇄',
}

export type TrustKind = 'both' | 'given' | 'received'

export function trustKind(t: TrustState): TrustKind | null {
  if (t.given && t.received) return 'both'
  if (t.given) return 'given'
  if (t.received) return 'received'
  return null
}

export const TRUST_GLYPH: Record<TrustKind, string> = { both: '⇆', given: '→', received: '←' }

export const SYSTEM_GLYPH: Record<SystemKind, { glyph: string; tone: Tone }> = {
  mutual: { glyph: '⇄', tone: 'primary' },
  nowMutual: { glyph: '⇄', tone: 'primary' },
  remet: { glyph: '⇄', tone: 'primary' },
  incoming: { glyph: '←', tone: 'primary' },
  outgoing: { glyph: '→', tone: 'primary' },
  introducedBy: { glyph: '◇', tone: 'warning' },
  trustBoth: { glyph: '⇆', tone: 'success' },
  trustOut: { glyph: '→', tone: 'success' },
  trustIn: { glyph: '←', tone: 'success' },
  trustWithdrawn: { glyph: '·', tone: 'muted' },
  paused: { glyph: '·', tone: 'muted' },
  resumed: { glyph: '·', tone: 'muted' },
  introduced: { glyph: '◇', tone: 'warning' },
  invited: { glyph: '⏳', tone: 'warning' },
  vouched: { glyph: '✓', tone: 'primary' },
  admitted: { glyph: '✓', tone: 'primary' },
  founded: { glyph: '✓', tone: 'primary' },
  joined: { glyph: '✓', tone: 'primary' },
  left: { glyph: '·', tone: 'muted' },
  reported: { glyph: '·', tone: 'muted' },
  blocked: { glyph: '·', tone: 'muted' },
  unblocked: { glyph: '·', tone: 'muted' },
}

export const DECISION_GLYPH: Record<Decision['kind'], { glyph: string; tone: Tone }> = {
  'encounter-confirm': { glyph: '←', tone: 'primary' },
  'group-invite': { glyph: '⏳', tone: 'warning' },
  vouch: { glyph: '✓', tone: 'primary' },
  introduction: { glyph: '◇', tone: 'warning' },
}

/** blocked on this device (paper §7) */
export const BLOCKED_GLYPH = '⊘'
