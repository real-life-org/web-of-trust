// Text of a conversation preview, from the port's preview model (message text or i18n key + values).
import type { ConversationPreview, Decision } from '../../port'
import type { I18n } from '../../i18n'
import { DECISION_GLYPH, SYSTEM_GLYPH } from './glyphs'

function isDecisionKind(k: string): k is Decision['kind'] {
  return k in DECISION_GLYPH
}

function isSystemKind(k: string): k is keyof typeof SYSTEM_GLYPH {
  return k in SYSTEM_GLYPH
}

export function previewText(p: ConversationPreview | null, { t, f }: I18n, opts: { group: boolean }): string {
  if (p === null) return ''
  if (p.kind === 'message') {
    const a = p.authorLabel
    const prefix =
      a?.kind === 'self'
        ? t.contacts.you
        : opts.group && a?.kind === 'contact'
          ? (a.name ?? t.contacts.unnamed)
          : opts.group && a?.kind === 'member'
            ? f(t.contacts.member, { handle: a.handle })
            : null
    return prefix ? `${prefix}: ${p.text}` : p.text
  }
  const key = p.i18n?.key ?? ''
  const values = p.i18n?.values ?? {}
  if (p.kind === 'system' && isSystemKind(key)) return `${SYSTEM_GLYPH[key].glyph} ${f(t.system[key], values)}`
  if (p.kind === 'decision' && isDecisionKind(key)) {
    const d = t.decision[key]
    const title = key === 'group-invite' && !values.group ? t.decision['group-invite'].titleUnknown : d.title
    return `${d.kind}: ${f(title, values)}`
  }
  return ''
}
