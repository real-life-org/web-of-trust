// The verification tag of a contact. A contact met and confirmed by neither side yet (the return code
// was scanned, the question is open) says so, and never carries the sign of a mutual verification
// (Anton 23.11.).
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LanguageProvider } from '../src/i18n'
import { VerificationBadge } from '../src/ui/components'
import { VERIFICATION_GLYPH } from '../src/ui/components/glyphs'

describe('the verification tag', () => {
  it('met: "unbestätigt" / "unconfirmed", with a sign of its own', () => {
    const { unmount } = render(<LanguageProvider lang="de"><VerificationBadge verification="met" /></LanguageProvider>)
    expect(screen.getByText('unbestätigt')).toBeInTheDocument()
    unmount()
    render(<LanguageProvider lang="en"><VerificationBadge verification="met" /></LanguageProvider>)
    expect(screen.getByText('unconfirmed')).toBeInTheDocument()
  })

  it('every state has its own sign', () => {
    const signs = Object.values(VERIFICATION_GLYPH)
    expect(new Set(signs).size).toBe(signs.length)
  })
})
