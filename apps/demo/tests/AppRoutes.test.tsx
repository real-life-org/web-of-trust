/**
 * Tests for AppRoutes layout selection logic.
 *
 * Verifies that:
 * - During identity init: loading screen is shown (no layout flash)
 * - Stored identity but not yet unlocked: RequireIdentity handles it (no standalone flash)
 * - No stored identity: /p/:did renders standalone, other routes go to onboarding
 * - Logged in: all routes render inside AppShell with navigation
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Mock the heavy dependencies before importing App components
vi.mock('../src/context/AdapterContext', () => ({
  AdapterProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAdapters: () => ({}),
  useOptionalAdapters: () => null,
}))

vi.mock('../src/context/PendingVerificationContext', () => ({
  PendingVerificationProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ConfettiProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  usePendingVerification: () => ({
    confettiKey: 0,
    toastMessage: null,
    triggerConfetti: vi.fn(),
    mutualPeer: null,
    triggerMutualDialog: vi.fn(),
    dismissMutualDialog: vi.fn(),
    incomingAttestation: null,
    triggerAttestationDialog: vi.fn(),
    dismissAttestationDialog: vi.fn(),
    challengeNonce: null,
    setChallengeNonce: vi.fn(),
    pendingIncoming: null,
    setPendingIncoming: vi.fn(),
  }),
  useConfetti: () => ({
    confettiKey: 0,
    toastMessage: null,
    triggerConfetti: vi.fn(),
    mutualPeer: null,
    triggerMutualDialog: vi.fn(),
    dismissMutualDialog: vi.fn(),
    incomingAttestation: null,
    triggerAttestationDialog: vi.fn(),
    dismissAttestationDialog: vi.fn(),
    challengeNonce: null,
    setChallengeNonce: vi.fn(),
    pendingIncoming: null,
    setPendingIncoming: vi.fn(),
  }),
}))

vi.mock('../src/hooks/useProfileSync', () => ({
  useProfileSync: () => ({
    uploadProfile: vi.fn(),
    fetchContactProfile: vi.fn(),
    syncContactProfile: vi.fn(),
    uploadVerificationsAndAttestations: vi.fn(),
  }),
}))

vi.mock('../src/hooks/useMessaging', () => ({
  useMessaging: () => ({
    send: vi.fn(),
    onMessage: () => () => {},
    state: 'disconnected',
    isConnected: false,
  }),
}))

vi.mock('../src/hooks/useContacts', () => ({
  useContacts: () => ({
    contacts: [],
    activeContacts: [],
    pendingContacts: [],
    addContact: vi.fn(),
    activateContact: vi.fn(),
    updateContactName: vi.fn(),
    removeContact: vi.fn(),
    refresh: vi.fn(),
  }),
}))

vi.mock('../src/hooks/useVerificationStatus', () => ({
  useVerificationStatus: () => ({
    getStatus: () => 'none',
    allVerifications: [],
  }),
  getVerificationStatus: () => 'none',
}))

// Mock identity context with controllable state
const mockIdentityState = {
  identity: null as unknown | null,
  did: null as string | null,
  hasStoredIdentity: null as boolean | null,
  initialProfile: null,
  setIdentity: vi.fn(),
  clearIdentity: vi.fn(),
  consumeInitialProfile: vi.fn(),
}

vi.mock('../src/context/IdentityContext', () => ({
  IdentityProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useIdentity: () => mockIdentityState,
}))

// Mock page components to simple markers
vi.mock('../src/pages', () => ({
  Home: () => <div data-testid="page-home">Home</div>,
  Identity: () => <div data-testid="page-identity">Identity</div>,
  Contacts: () => <div data-testid="page-contacts">Contacts</div>,
  Verify: () => <div data-testid="page-verify">Verify</div>,
  Attestations: () => <div data-testid="page-attestations">Attestations</div>,
  PublicProfile: () => <div data-testid="page-public-profile">PublicProfile</div>,
  Spaces: () => <div data-testid="page-spaces">Spaces</div>,
  Network: () => <div data-testid="page-network">Network</div>,
}))

// Mock AppShell to render children with a marker
vi.mock('../src/components', () => ({
  AppShell: () => {
    // AppShell uses Outlet from react-router
    const { Outlet } = require('react-router-dom')
    return (
      <div data-testid="app-shell">
        <nav data-testid="app-navigation">Navigation</nav>
        <Outlet />
      </div>
    )
  },
  IdentityManagement: ({ onComplete }: { onComplete: () => void }) => (
    <div data-testid="identity-management">Onboarding</div>
  ),
  Confetti: () => null,
}))

// Import App after all mocks are set up
import App from '../src/App'

function renderApp(route: string = '/') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <App />
    </MemoryRouter>,
  )
}

// We need to render without BrowserRouter since App includes it.
// Instead, let's test the internal components directly.
// But App wraps everything in BrowserRouter, so we need a different approach.
// Let's re-mock App to not include BrowserRouter and test AppRoutes directly.

// Actually, let's just export and test the routing logic.
// Since App uses BrowserRouter internally, we'll test by importing the inner components.

// Simpler approach: render the full App but override BrowserRouter
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    BrowserRouter: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  }
})

describe('AppRoutes', () => {
  beforeEach(() => {
    // Reset to "still loading" state
    mockIdentityState.identity = null
    mockIdentityState.did = null
    mockIdentityState.hasStoredIdentity = null
    mockIdentityState.initialProfile = null
  })

  describe('during identity initialization (hasStoredIdentity === null)', () => {
    it('should show loading state on /', () => {
      renderApp('/')
      expect(screen.getByText(/Lade\.\.\.|Loading\.\.\./)).toBeInTheDocument()
      expect(screen.queryByTestId('app-shell')).not.toBeInTheDocument()
      expect(screen.queryByTestId('page-public-profile')).not.toBeInTheDocument()
    })

    it('should show loading state on /p/:did (not standalone)', () => {
      renderApp('/p/did:key:z6MkTest')
      expect(screen.getByText(/Lade\.\.\.|Loading\.\.\./)).toBeInTheDocument()
      expect(screen.queryByTestId('page-public-profile')).not.toBeInTheDocument()
    })
  })

  describe('stored identity exists but not unlocked (hasStoredIdentity === true, identity === null)', () => {
    beforeEach(() => {
      mockIdentityState.hasStoredIdentity = true
    })

    it('should show onboarding/passphrase prompt, not standalone layout', () => {
      renderApp('/p/did:key:z6MkTest')
      // RequireIdentity should show IdentityManagement (passphrase prompt)
      expect(screen.getByTestId('identity-management')).toBeInTheDocument()
      // Should NOT show standalone layout
      expect(screen.queryByText('PublicProfile')).not.toBeInTheDocument()
    })

    it('should show onboarding on /', () => {
      renderApp('/')
      expect(screen.getByTestId('identity-management')).toBeInTheDocument()
    })
  })

  describe('no stored identity (hasStoredIdentity === false)', () => {
    beforeEach(() => {
      mockIdentityState.hasStoredIdentity = false
    })

    it('should show public profile in standalone layout on /p/:did', () => {
      renderApp('/p/did:key:z6MkTest')
      expect(screen.getByTestId('page-public-profile')).toBeInTheDocument()
      // No AppShell navigation
      expect(screen.queryByTestId('app-navigation')).not.toBeInTheDocument()
    })

    it('should show onboarding on /', () => {
      renderApp('/')
      expect(screen.getByTestId('identity-management')).toBeInTheDocument()
    })
  })

  describe('logged in (identity exists)', () => {
    beforeEach(() => {
      mockIdentityState.identity = { getDid: () => 'did:key:z6MkMyDid' } // mock identity
      mockIdentityState.did = 'did:key:z6MkMyDid'
      mockIdentityState.hasStoredIdentity = true
    })

    it('should render / inside AppShell', () => {
      renderApp('/')
      expect(screen.getByTestId('app-shell')).toBeInTheDocument()
      expect(screen.getByTestId('app-navigation')).toBeInTheDocument()
      expect(screen.getByTestId('page-home')).toBeInTheDocument()
    })

    it('should render /p/:did inside AppShell with navigation', () => {
      renderApp('/p/did:key:z6MkOther')
      expect(screen.getByTestId('app-shell')).toBeInTheDocument()
      expect(screen.getByTestId('app-navigation')).toBeInTheDocument()
      expect(screen.getByTestId('page-public-profile')).toBeInTheDocument()
    })

    it('should render /contacts inside AppShell', () => {
      renderApp('/contacts')
      expect(screen.getByTestId('app-shell')).toBeInTheDocument()
      expect(screen.getByTestId('page-contacts')).toBeInTheDocument()
    })

    it('should redirect unknown routes to /', () => {
      renderApp('/nonexistent')
      expect(screen.getByTestId('app-shell')).toBeInTheDocument()
      expect(screen.getByTestId('page-home')).toBeInTheDocument()
    })
  })
})
