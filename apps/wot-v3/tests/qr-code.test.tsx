// The QR component (architecture §5.3): a link longer than a QR of version 40 holds (a card with the
// largest free text, #439) draws no code and does not throw; it shows the given text instead, and the
// screen keeps its copy path.
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QrCode, qrPath } from '../src/ui/components/QrCode'

const TOO_LONG = `https://web-of-trust.de/c#1:${'A'.repeat(5000)}`

describe('QrCode', () => {
  it('qrPath answers null for a text no QR version holds', () => {
    expect(qrPath(TOO_LONG)).toBeNull()
    expect(qrPath('https://web-of-trust.de/c#1:ABC')?.version).toBe(3)
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
