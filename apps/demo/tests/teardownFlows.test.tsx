/**
 * Teardown-Completeness component flows (model W3 / W5 / W1b). Renders the real
 * identity components with mocked contexts + services (pattern: SpaceFormAdmin.test).
 * Language forced to German for deterministic copy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { LanguageProvider } from '../src/i18n'

const h = vi.hoisted(() => {
  const state = { enrolled: false, biometricEnrolled: false }
  return {
    state,
    refreshBiometricStatus: vi.fn(),
    authenticate: vi.fn(async () => {
      throw new Error('USER_CANCELLED')
    }),
    isAvailable: vi.fn(async () => false),
    isSupported: vi.fn(() => false),
    isEnrolled: vi.fn(async () => state.enrolled),
    isEnrolledStrict: vi.fn(async () => state.enrolled),
    enroll: vi.fn(async () => {}),
    unenroll: vi.fn(async () => {
      state.enrolled = false
    }),
    unlockStoredIdentity: vi.fn(async () => ({ identity: { getDid: () => 'did:key:zX' } })),
    recoverIdentity: vi.fn(async () => ({ identity: { getDid: () => 'did:key:zRecovered' } })),
    deleteStoredIdentity: vi.fn(async () => {}),
    resetLocalAppData: vi.fn(async () => {}),
    findSurvivingWipeTier: vi.fn(async (): Promise<string | null> => null),
  }
})

vi.mock('../src/context/IdentityContext', () => ({
  useIdentity: () => ({
    biometricEnrolled: h.state.biometricEnrolled,
    refreshBiometricStatus: h.refreshBiometricStatus,
  }),
}))
vi.mock('../src/services/BiometricService', () => ({
  BiometricService: {
    isSupported: () => h.isSupported(),
    isAvailable: () => h.isAvailable(),
    isEnrolled: () => h.isEnrolled(),
    isEnrolledStrict: () => h.isEnrolledStrict(),
    authenticate: () => h.authenticate(),
    enroll: (p: string) => h.enroll(p),
    unenroll: () => h.unenroll(),
  },
}))
vi.mock('../src/services/identityWorkflow', () => ({
  createIdentityWorkflow: () => ({
    unlockStoredIdentity: (a: unknown) => h.unlockStoredIdentity(a),
    recoverIdentity: (a: unknown) => h.recoverIdentity(a),
    deleteStoredIdentity: () => h.deleteStoredIdentity(),
  }),
}))
vi.mock('../src/services/resetLocalAppData', () => ({
  resetLocalAppData: () => h.resetLocalAppData(),
  findSurvivingWipeTier: () => h.findSurvivingWipeTier(),
}))

import { UnlockFlow } from '../src/components/identity/UnlockFlow'
import { RecoveryFlow } from '../src/components/identity/RecoveryFlow'

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  localStorage.setItem('wot-language', 'de')
  h.state.enrolled = false
  h.state.biometricEnrolled = false
  h.authenticate.mockImplementation(async () => {
    throw new Error('USER_CANCELLED')
  })
  h.isAvailable.mockImplementation(async () => false)
  h.isSupported.mockImplementation(() => false)
  h.isEnrolled.mockImplementation(async () => h.state.enrolled)
  h.isEnrolledStrict.mockImplementation(async () => h.state.enrolled)
  h.enroll.mockImplementation(async () => {})
  h.unenroll.mockImplementation(async () => {
    h.state.enrolled = false
  })
  h.unlockStoredIdentity.mockImplementation(async () => ({ identity: { getDid: () => 'did:key:zX' } }))
  h.recoverIdentity.mockImplementation(async () => ({ identity: { getDid: () => 'did:key:zRecovered' } }))
  h.deleteStoredIdentity.mockImplementation(async () => {})
  h.resetLocalAppData.mockImplementation(async () => {})
  h.findSurvivingWipeTier.mockImplementation(async () => null)
})

describe('W3 — UnlockFlow password fallback (no soft-lockout trap)', () => {
  it('reveals a password unlock after the auto biometric attempt fails', async () => {
    h.state.biometricEnrolled = true
    h.authenticate.mockImplementation(async () => {
      throw new Error('USER_CANCELLED')
    })

    render(
      <LanguageProvider>
        <UnlockFlow onComplete={vi.fn()} onRecover={vi.fn()} />
      </LanguageProvider>,
    )

    await waitFor(() =>
      expect(screen.getByText('Stattdessen mit Passwort entsperren')).toBeInTheDocument(),
    )
    expect(screen.getByPlaceholderText('Dein Passwort')).toBeInTheDocument()
  })
})

describe('W5 — UnlockFlow create-new fails closed when a tier survives', () => {
  it('does NOT redirect and surfaces an error when findSurvivingWipeTier reports a survivor', async () => {
    h.state.biometricEnrolled = false
    // Drive into the unsupported-identity state so the "create new" button appears.
    h.unlockStoredIdentity.mockImplementation(async () => {
      throw new Error('unsupported local identity format')
    })
    h.resetLocalAppData.mockResolvedValue(undefined)
    h.findSurvivingWipeTier.mockResolvedValue('stored identity seed survived the wipe')

    // Intercept any redirect attempt without navigating happy-dom. Override ONLY the
    // href accessor on the location instance (a Proxy over the whole object breaks
    // happy-dom's private #url fields); search/pathname still use the real accessors.
    const hrefSpy = vi.fn()
    Object.defineProperty(window.location, 'href', {
      configurable: true,
      get: () => 'http://localhost:3000/',
      set: (v: string) => hrefSpy(v),
    })

    try {
      render(
        <LanguageProvider>
          <UnlockFlow onComplete={vi.fn()} onRecover={vi.fn()} />
        </LanguageProvider>,
      )

      fireEvent.change(screen.getByPlaceholderText('Dein Passwort'), { target: { value: 'pw-123456' } })
      fireEvent.click(screen.getByRole('button', { name: 'Entsperren' }))

      const createBtn = await screen.findByRole('button', { name: 'Neue ID erstellen' })
      fireEvent.click(createBtn)

      await waitFor(() => expect(h.findSurvivingWipeTier).toHaveBeenCalled())
      await waitFor(() =>
        expect(screen.getByText(/Zurücksetzen unvollständig/)).toBeInTheDocument(),
      )
      expect(hrefSpy).not.toHaveBeenCalled() // failed closed → no redirect
    } finally {
      delete (window.location as unknown as { href?: string }).href // revert to the real accessor
    }
  })
})

describe('W1b — RecoveryFlow password path reconciles the keystore', () => {
  it('clears a stale keystore entry when enroll fails after the seed is replaced', async () => {
    h.state.enrolled = true // pre-existing OLD keystore passphrase (the orphan trap)
    h.isAvailable.mockResolvedValue(true)
    h.isSupported.mockReturnValue(true)
    h.enroll.mockImplementation(async () => {
      throw new Error('enroll failed / cancelled')
    })

    render(
      <LanguageProvider>
        <RecoveryFlow onComplete={vi.fn()} onCancel={vi.fn()} />
      </LanguageProvider>,
    )

    // Step 1 — import 12 magic words, advance to the protect step.
    const words = 'aaa bbb ccc ddd eee fff ggg hhh iii jjj kkk lll'
    fireEvent.change(screen.getByPlaceholderText(/word1/), { target: { value: words } })
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))

    // Step 3 — protect with a password; enroll throws → W1b unenroll reconcile.
    const pwInput = await screen.findByPlaceholderText('Mindestens 8 Zeichen')
    fireEvent.change(pwInput, { target: { value: 'pw-123456' } })
    fireEvent.change(screen.getByPlaceholderText('Passwort wiederholen'), {
      target: { value: 'pw-123456' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Identität wiederherstellen' }))

    await waitFor(() => expect(h.unenroll).toHaveBeenCalled())
    // The stale entry is GONE (cleared state, not just "unenroll was called").
    expect(await h.isEnrolled()).toBe(false)
  })

  it('clears a pre-existing entry on the password path even when biometrics are UNAVAILABLE', async () => {
    // isEnrolled (a stored passphrase) can be true while isAvailable is false (e.g.
    // fingerprints removed). The reconcile must NOT be gated on biometricAvailable.
    h.state.enrolled = true // pre-existing OLD keystore passphrase
    h.isAvailable.mockResolvedValue(false)
    h.isSupported.mockReturnValue(true)

    render(
      <LanguageProvider>
        <RecoveryFlow onComplete={vi.fn()} onCancel={vi.fn()} />
      </LanguageProvider>,
    )

    const words = 'aaa bbb ccc ddd eee fff ggg hhh iii jjj kkk lll'
    fireEvent.change(screen.getByPlaceholderText(/word1/), { target: { value: words } })
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))

    const pwInput = await screen.findByPlaceholderText('Mindestens 8 Zeichen')
    fireEvent.change(pwInput, { target: { value: 'pw-123456' } })
    fireEvent.change(screen.getByPlaceholderText('Passwort wiederholen'), {
      target: { value: 'pw-123456' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Identität wiederherstellen' }))

    await waitFor(() => expect(h.unenroll).toHaveBeenCalled())
    expect(h.enroll).not.toHaveBeenCalled() // biometrics unusable → no enroll attempt
    expect(await h.isEnrolled()).toBe(false)
  })
})
