/**
 * Onboarding / Recovery password step: the submit button stays disabled until the
 * confirmation matches AND the 8-char minimum is met, with a live mismatch hint.
 * Renders the real identity components with mocked contexts + services
 * (pattern: teardownFlows.test / SpaceFormAdmin.test). German copy forced for
 * deterministic assertions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { LanguageProvider } from '../src/i18n'

// A 12-word mnemonic of identical words makes the onboarding verify step
// deterministic: whichever 3 random indices are picked, typing the same word
// back matches words[i] for every one of them.
const UNIFORM_MNEMONIC = Array(12).fill('alpha').join(' ')

const h = vi.hoisted(() => ({
  refreshBiometricStatus: vi.fn(),
  isAvailable: vi.fn(async () => false),
  enroll: vi.fn(async () => {}),
  unenroll: vi.fn(async () => {}),
  isEnrolledStrict: vi.fn(async () => false),
  createIdentity: vi.fn(async () => ({
    mnemonic: UNIFORM_MNEMONIC,
    identity: { did: 'did:key:zOnboard', getDid: () => 'did:key:zOnboard' },
  })),
  recoverIdentity: vi.fn(async () => ({ identity: { getDid: () => 'did:key:zRecovered' } })),
  deleteStoredIdentity: vi.fn(async () => {}),
}))

vi.mock('../src/context/IdentityContext', () => ({
  useIdentity: () => ({
    biometricEnrolled: false,
    refreshBiometricStatus: h.refreshBiometricStatus,
  }),
}))
vi.mock('../src/services/BiometricService', () => ({
  BiometricService: {
    isAvailable: () => h.isAvailable(),
    enroll: (p: string) => h.enroll(p),
    unenroll: () => h.unenroll(),
    isEnrolledStrict: () => h.isEnrolledStrict(),
  },
}))
vi.mock('../src/services/identityWorkflow', () => ({
  createIdentityWorkflow: () => ({
    createIdentity: (a: unknown) => h.createIdentity(a),
    recoverIdentity: (a: unknown) => h.recoverIdentity(a),
    deleteStoredIdentity: () => h.deleteStoredIdentity(),
  }),
}))

import { OnboardingFlow } from '../src/components/identity/OnboardingFlow'
import { RecoveryFlow } from '../src/components/identity/RecoveryFlow'

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  localStorage.setItem('wot-language', 'de')
  h.isAvailable.mockResolvedValue(false)
  h.createIdentity.mockResolvedValue({
    mnemonic: UNIFORM_MNEMONIC,
    identity: { did: 'did:key:zOnboard', getDid: () => 'did:key:zOnboard' },
  })
  h.recoverIdentity.mockResolvedValue({ identity: { getDid: () => 'did:key:zRecovered' } })
})

/** Drive OnboardingFlow generate → display → verify → profile → protect. */
async function reachOnboardingProtectStep() {
  fireEvent.click(screen.getByRole('button', { name: 'Identität generieren' }))

  // Display step: tick the 3 checklist items (custom <label> toggles, not native
  // checkboxes), then continue.
  await screen.findByText('Deine Magischen Wörter')
  fireEvent.click(screen.getByText('Ich habe alle 12 Magischen Wörter aufgeschrieben'))
  fireEvent.click(screen.getByText('Ich habe sie an einem sicheren Ort verwahrt'))
  fireEvent.click(screen.getByText('Ich verstehe, dass sie nicht wiederhergestellt werden können'))
  fireEvent.click(screen.getByRole('button', { name: 'Weiter zur Verifizierung' }))

  // Verify step: every word is 'alpha', so fill each input with it.
  await screen.findByText('Verifizierung')
  screen.getAllByPlaceholderText('Wort eingeben...').forEach((input) =>
    fireEvent.change(input, { target: { value: 'alpha' } }),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Verifizieren' }))

  // Profile step: biometrics unavailable → the primary button reads "Weiter".
  await screen.findByText('Dein Profil')
  fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))

  await screen.findByText('Schütze deine Identität')
}

describe('OnboardingFlow — password confirmation gate', () => {
  it('keeps the protect button disabled until both fields match at min length, with a live hint', async () => {
    render(
      <LanguageProvider>
        <OnboardingFlow onComplete={vi.fn()} />
      </LanguageProvider>,
    )
    await reachOnboardingProtectStep()

    const protectBtn = screen.getByRole('button', { name: 'Identität schützen' })
    const pw = screen.getByPlaceholderText('Mindestens 8 Zeichen')
    const confirm = screen.getByPlaceholderText('Passwort wiederholen')

    // Empty → disabled, no hint yet.
    expect(protectBtn).toBeDisabled()
    expect(screen.queryByText('Passwörter stimmen nicht überein')).not.toBeInTheDocument()

    // Mismatch → disabled + live hint.
    fireEvent.change(pw, { target: { value: 'pw-123456' } })
    fireEvent.change(confirm, { target: { value: 'pw-different' } })
    expect(protectBtn).toBeDisabled()
    expect(screen.getByText('Passwörter stimmen nicht überein')).toBeInTheDocument()

    // Matching but too short → still disabled (min length), no mismatch hint.
    fireEvent.change(pw, { target: { value: 'short' } })
    fireEvent.change(confirm, { target: { value: 'short' } })
    expect(protectBtn).toBeDisabled()
    expect(screen.queryByText('Passwörter stimmen nicht überein')).not.toBeInTheDocument()

    // Matching + long enough → enabled, hint gone.
    fireEvent.change(pw, { target: { value: 'pw-123456' } })
    fireEvent.change(confirm, { target: { value: 'pw-123456' } })
    expect(protectBtn).toBeEnabled()
    expect(screen.queryByText('Passwörter stimmen nicht überein')).not.toBeInTheDocument()
  })
})

describe('RecoveryFlow — password confirmation gate', () => {
  async function reachRecoveryProtectStep() {
    const words = Array(12).fill('aaa').join(' ')
    fireEvent.change(screen.getByPlaceholderText(/word1/), { target: { value: words } })
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))
    await screen.findByPlaceholderText('Mindestens 8 Zeichen')
  }

  it('keeps the recover button disabled until both fields match at min length, with a live hint', async () => {
    render(
      <LanguageProvider>
        <RecoveryFlow onComplete={vi.fn()} onCancel={vi.fn()} />
      </LanguageProvider>,
    )
    await reachRecoveryProtectStep()

    const recoverBtn = screen.getByRole('button', { name: 'Identität wiederherstellen' })
    const pw = screen.getByPlaceholderText('Mindestens 8 Zeichen')
    const confirm = screen.getByPlaceholderText('Passwort wiederholen')

    expect(recoverBtn).toBeDisabled()
    expect(screen.queryByText('Passwörter stimmen nicht überein')).not.toBeInTheDocument()

    fireEvent.change(pw, { target: { value: 'pw-123456' } })
    fireEvent.change(confirm, { target: { value: 'pw-different' } })
    expect(recoverBtn).toBeDisabled()
    expect(screen.getByText('Passwörter stimmen nicht überein')).toBeInTheDocument()

    fireEvent.change(pw, { target: { value: 'short' } })
    fireEvent.change(confirm, { target: { value: 'short' } })
    expect(recoverBtn).toBeDisabled()
    expect(screen.queryByText('Passwörter stimmen nicht überein')).not.toBeInTheDocument()

    fireEvent.change(pw, { target: { value: 'pw-123456' } })
    fireEvent.change(confirm, { target: { value: 'pw-123456' } })
    expect(recoverBtn).toBeEnabled()
    expect(screen.queryByText('Passwörter stimmen nicht überein')).not.toBeInTheDocument()
  })

  it('Enter cannot bypass the gate; it submits only once the gate is satisfied', async () => {
    render(
      <LanguageProvider>
        <RecoveryFlow onComplete={vi.fn()} onCancel={vi.fn()} />
      </LanguageProvider>,
    )
    await reachRecoveryProtectStep()
    h.recoverIdentity.mockClear() // step 1 validation already called it once

    const pw = screen.getByPlaceholderText('Mindestens 8 Zeichen')
    const confirm = screen.getByPlaceholderText('Passwort wiederholen')

    // Matching but below min length: an ungated Enter would reach handleProtect,
    // which surfaces the min-length error. The gated handler must do nothing.
    fireEvent.change(pw, { target: { value: 'short' } })
    fireEvent.change(confirm, { target: { value: 'short' } })
    fireEvent.keyDown(confirm, { key: 'Enter' })
    expect(screen.queryByText('Passwort muss mindestens 8 Zeichen lang sein')).not.toBeInTheDocument()
    expect(h.recoverIdentity).not.toHaveBeenCalled()

    // Gate satisfied: Enter submits (keyboard path still works).
    fireEvent.change(pw, { target: { value: 'pw-123456' } })
    fireEvent.change(confirm, { target: { value: 'pw-123456' } })
    fireEvent.keyDown(confirm, { key: 'Enter' })
    await waitFor(() => expect(h.recoverIdentity).toHaveBeenCalled())
  })
})
