// The QR component (architecture §5.3): a link longer than a QR of version 40 holds (a card with the
// largest free text, #439) draws no code and does not throw; it shows the given text instead, and the
// screen keeps its copy path.
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { create } from 'qrcode'
import { QR_ERROR_CORRECTION, QrCode, qrPath } from '../src/ui/components/QrCode'

const TOO_LONG = `https://web-of-trust.de/c#1:${'A'.repeat(5000)}`

describe('QrCode', () => {
  it('qrPath answers null for a text no QR version holds', () => {
    expect(qrPath(TOO_LONG)).toBeNull()
    expect(qrPath('https://web-of-trust.de/c#1:ABC')?.version).toBe(2)
  })

  it('draws at error correction L: every code is shown on a screen, nothing covers or damages it', () => {
    expect(QR_ERROR_CORRECTION).toBe('L')
    const link = `https://web-of-trust.de/t#${'A1b2C3'.repeat(110)}`
    expect(qrPath(link)?.version).toBe(create(link, { errorCorrectionLevel: 'L' }).version)
    expect(qrPath(link)?.version).toBeLessThan(create(link, { errorCorrectionLevel: 'M' }).version)
  })

  it('draws the text instead of a code when the link does not fit, without throwing', () => {
    render(<QrCode value={TOO_LONG} label="Your code" tooLarge="Too large for a QR code. Copy it instead." />)
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('Too large for a QR code. Copy it instead.')).toBeTruthy()
  })

  it('draws the code when it fits', () => {
    render(<QrCode value="https://web-of-trust.de/c#1:ABC" label="Your code" tooLarge="unused" />)
    expect(screen.getByRole('img', { name: 'Your code' })).toBeTruthy()
  })
})
