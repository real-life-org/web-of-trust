import { describe, expect, it, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import * as React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Attestation, Contact } from '@web_of_trust/core/types'

const mocks = vi.hoisted(() => {
  const emptySubscribable = <T,>(value: T) => ({
    getValue: () => value,
    subscribe: () => () => {},
  })

  return {
    identityState: {
      identity: { getDid: () => 'did:key:viewer' },
      did: 'did:key:viewer',
    },
    contacts: [] as Contact[],
    localIdentity: null as null,
    localAttestations: [] as Attestation[],
    discovery: {
      resolveProfile: vi.fn(),
      resolveAttestations: vi.fn(),
      resolveVerifications: vi.fn(),
    },
    graphCacheStore: {
      cacheEntry: vi.fn(),
      resolveNames: vi.fn(),
    },
    emptySubscribable,
  }
})

vi.mock('../src/runtime/appRuntime', () => ({
  createHttpDiscoveryAdapter: () => mocks.discovery,
}))

vi.mock('../src/context', () => ({
  useIdentity: () => mocks.identityState,
  useOptionalAdapters: () => ({
    discovery: mocks.discovery,
    graphCacheStore: mocks.graphCacheStore,
    reactiveStorage: {
      watchContacts: () => mocks.emptySubscribable(mocks.contacts),
      watchIdentity: () => mocks.emptySubscribable(mocks.localIdentity),
      watchAllAttestations: () => mocks.emptySubscribable(mocks.localAttestations),
    },
  }),
}))

vi.mock('../src/i18n', () => ({
  plural: (count: number, one: string, many: string) => count === 1 ? one : many,
  useLanguage: () => ({
    t: {
      common: {
        attestationOne: 'Bestätigung',
        attestationMany: 'Bestätigungen',
        from: 'von',
        personOne: 'Person',
        personMany: 'Personen',
      },
      contacts: {
        statusIncoming: 'incoming',
        statusMutual: 'mutual',
        statusOutgoing: 'outgoing',
      },
      publicProfile: {
        attestPerson: 'Bestätigung erstellen',
        attestPersonDesc: 'Bestätige etwas über {name}',
        attestationCount: '{count} {attestationLabel}',
        contactBadge: '(Kontakt)',
        errorDescription: 'Das Profil konnte nicht geladen oder verifiziert werden.',
        errorTitle: 'Fehler beim Laden',
        joinButton: 'Jetzt starten',
        joinCta: 'Dem Web of Trust beitreten',
        loading: 'Profil wird geladen...',
        mutualContactPlural: '{count} deiner Kontakte kennen diese Person: {names}.',
        mutualContactSingular: '{name} kennt diese Person auch.',
        notFoundDescription: 'Für diese DID wurde kein öffentliches Profil hinterlegt.',
        notFoundTitle: 'Kein Profil gefunden',
        offlineBanner: 'Du bist offline. Die angezeigten Daten stammen aus dem lokalen Speicher und sind möglicherweise nicht aktuell.',
        offlineDescription: 'Das Profil kann nicht geladen werden, da keine Internetverbindung besteht.',
        offlineTitle: 'Du bist offline',
        publicTitle: 'Öffentliches Profil',
        title: 'Profil',
        unknown: 'Unbekannt',
        verifiedBanner: 'Signiert',
        verifiedByCount: 'Verbunden mit {count} {personLabel}',
        verifyButton: 'Verbinden',
        verifyPerson: 'Person verbinden',
        youSuffix: ' (Du)',
        yourContactBadge: '(dein Kontakt)',
      },
      aria: {
        copyDid: 'DID kopieren',
        shareProfile: 'Profil teilen',
      },
    },
    fmt: (template: string, vars: Record<string, string | number>) =>
      Object.entries(vars).reduce((text, [key, value]) => text.replace(`{${key}}`, String(value)), template),
    formatDate: () => '2026-05-22',
  }),
}))

import { PublicProfile } from '../src/pages/PublicProfile'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(testDir, '..', '..', '..')

function readRepoFile(file: string): string {
  return fs.readFileSync(path.resolve(repoRoot, file), 'utf8')
}

describe('PublicProfile Trust 002 verification-attestation source guard', () => {
  it('renders public verification state from public attestations, not legacy verification documents', () => {
    const text = readRepoFile('apps/demo/src/pages/PublicProfile.tsx')

    expect(text).not.toContain('import type { PublicProfile as PublicProfileType, Verification')
    expect(text).not.toContain('watchReceivedVerifications')
    expect(text).not.toContain('Verification[]')
    expect(text).not.toContain('v.timestamp')

    // Step 6 / review MAJOR 2: PublicProfile resolves BOTH lists and keeps them
    // SEPARATE (no merge + claim-based re-split). The type-correct /v ÷ /a split
    // from the resolve adapter is preserved; classification never keys off the
    // claim text, so PublicProfile no longer calls the derived-form predicate.
    expect(text).toContain('resolveAttestations')
    expect(text).toContain('resolveVerifications')
    expect(text).toContain('getVerificationStatus')
    // The merge + claim re-split is gone.
    expect(text).not.toContain('[...vData, ...aData]')
    expect(text).not.toContain('isVerificationAttestation')
  })
})

function makeVerificationAttestation(from: string, to: string): Attestation {
  return {
    id: `att-${from}-${to}`,
    from,
    to,
    claim: 'in-person verifiziert',
    createdAt: '2026-05-22T12:00:00.000Z',
    vcJws: 'header.payload.signature',
    // Type-borne live-verification marker (review MAJOR 2): a real verification
    // carries it. It belongs in the /v resource (resolveVerifications).
    isVerification: true,
  }
}

function makeGenericAttestation(from: string, to: string, claim = 'helped with setup'): Attestation {
  return {
    id: `att-generic-${from}-${to}`,
    from,
    to,
    claim,
    createdAt: '2026-05-22T12:00:00.000Z',
    vcJws: 'header.payload.signature',
    isVerification: false,
  }
}

function NavigateTo({ did }: { did: string }) {
  const navigate = useNavigate()

  React.useEffect(() => {
    navigate(`/p/${encodeURIComponent(did)}`)
  }, [did, navigate])

  return null
}

function renderPublicProfile(did: string) {
  return render(
    <MemoryRouter initialEntries={[`/p/${encodeURIComponent(did)}`]}>
      <NavigateTo did={did} />
      <Routes>
        <Route path="/p/:did" element={<PublicProfile />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('PublicProfile fallback display state', () => {
  beforeEach(() => {
    mocks.contacts = []
    mocks.localAttestations = []
    mocks.discovery.resolveProfile.mockReset()
    mocks.discovery.resolveAttestations.mockReset()
    mocks.discovery.resolveAttestations.mockResolvedValue([])
    mocks.discovery.resolveVerifications.mockReset()
    mocks.discovery.resolveVerifications.mockResolvedValue([])
    mocks.graphCacheStore.cacheEntry.mockReset()
    mocks.graphCacheStore.resolveNames.mockReset()
    mocks.graphCacheStore.cacheEntry.mockResolvedValue(undefined)
    mocks.graphCacheStore.resolveNames.mockResolvedValue(new Map())
  })

  it('clears public verification-attestations when navigation falls back to local contact data', async () => {
    const firstDid = 'did:key:first'
    const secondDid = 'did:key:second'
    const verifierDid = 'did:key:verifier'

    mocks.contacts = [{
      did: secondDid,
      name: 'Second Contact',
      publicKey: '',
      status: 'active',
      createdAt: '2026-05-22T10:00:00.000Z',
      updatedAt: '2026-05-22T10:00:00.000Z',
    }]

    mocks.discovery.resolveProfile.mockImplementation(async (targetDid: string) => {
      if (targetDid === firstDid) {
        return {
          profile: {
            did: firstDid,
            name: 'First Profile',
            updatedAt: '2026-05-22T11:00:00.000Z',
          },
          fromCache: false,
        }
      }

      return { profile: null, fromCache: true }
    })
    // Verifications come from the /v resource (resolveVerifications), kept
    // separate from /a (review MAJOR 2).
    mocks.discovery.resolveVerifications.mockImplementation(async (targetDid: string) =>
      targetDid === firstDid ? [makeVerificationAttestation(verifierDid, firstDid)] : [],
    )

    const view = renderPublicProfile(firstDid)

    expect(await screen.findByText('First Profile')).toBeInTheDocument()
    expect(screen.getByText('Verbunden mit 1 Person')).toBeInTheDocument()
    expect(screen.getByText(verifierDid)).toBeInTheDocument()

    view.rerender(
      <MemoryRouter initialEntries={[`/p/${encodeURIComponent(firstDid)}`]}>
        <NavigateTo did={secondDid} />
        <Routes>
          <Route path="/p/:did" element={<PublicProfile />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(await screen.findByText('Second Contact')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByText('Verbunden mit 1 Person')).not.toBeInTheDocument()
      expect(screen.queryByText(verifierDid)).not.toBeInTheDocument()
    })
  })

  it('ignores public verification-attestations that are not addressed to the viewed DID', async () => {
    const profileDid = 'did:key:profile'
    const otherDid = 'did:key:other'
    const verifierDid = 'did:key:verifier'

    mocks.contacts = [{
      did: verifierDid,
      name: 'Known Verifier',
      publicKey: '',
      status: 'active',
      createdAt: '2026-05-22T10:00:00.000Z',
      updatedAt: '2026-05-22T10:00:00.000Z',
    }]

    mocks.discovery.resolveProfile.mockResolvedValue({
      profile: {
        did: profileDid,
        name: 'Target Profile',
        updatedAt: '2026-05-22T11:00:00.000Z',
      },
      fromCache: false,
    })
    mocks.discovery.resolveAttestations.mockResolvedValue([
      makeVerificationAttestation(verifierDid, otherDid),
    ])

    renderPublicProfile(profileDid)

    expect(await screen.findByText('Target Profile')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByText('Verbunden mit 1 Person')).not.toBeInTheDocument()
      expect(screen.queryByText('Known Verifier kennt diese Person auch.')).not.toBeInTheDocument()
    })
  })

  it('ignores generic public attestations that are not addressed to the viewed DID', async () => {
    const profileDid = 'did:key:profile'
    const otherDid = 'did:key:other'
    const attesterDid = 'did:key:attester'

    mocks.discovery.resolveProfile.mockResolvedValue({
      profile: {
        did: profileDid,
        name: 'Target Profile',
        updatedAt: '2026-05-22T11:00:00.000Z',
      },
      fromCache: false,
    })
    mocks.discovery.resolveAttestations.mockResolvedValue([
      makeGenericAttestation(attesterDid, otherDid, 'foreign claim'),
    ])

    renderPublicProfile(profileDid)

    expect(await screen.findByText('Target Profile')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByText('1 Bestätigung')).not.toBeInTheDocument()
      expect(screen.queryByText('foreign claim')).not.toBeInTheDocument()
    })
  })

  it('caches fresh public attestations with an empty legacy attestation-only list', async () => {
    const profileDid = 'did:key:profile'
    const attesterDid = 'did:key:attester'
    const publicAttestations = [makeGenericAttestation(attesterDid, profileDid, 'fresh claim')]

    mocks.discovery.resolveProfile.mockResolvedValue({
      profile: {
        did: profileDid,
        name: 'Target Profile',
        updatedAt: '2026-05-22T11:00:00.000Z',
      },
      fromCache: false,
    })
    mocks.discovery.resolveAttestations.mockResolvedValue(publicAttestations)

    renderPublicProfile(profileDid)

    expect(await screen.findByText('Target Profile')).toBeInTheDocument()
    await waitFor(() => {
      expect(mocks.graphCacheStore.cacheEntry).toHaveBeenCalledWith(
        profileDid,
        expect.objectContaining({
          profile: expect.objectContaining({ did: profileDid }),
          attestations: publicAttestations,
        }),
      )
    })
    expect(Object.keys(mocks.graphCacheStore).sort()).toEqual(['cacheEntry', 'resolveNames'])
  })

  it('shows the UNION of the disjoint /v and /a resources (Step 6, UX-inhaltsgleich)', async () => {
    const profileDid = 'did:key:profile'
    const verifierDid = 'did:key:verifier'
    const attesterDid = 'did:key:attester'

    mocks.discovery.resolveProfile.mockResolvedValue({
      profile: { did: profileDid, name: 'Target Profile', updatedAt: '2026-05-22T11:00:00.000Z' },
      fromCache: false,
    })
    // /v carries the verification, /a the generic attestation — disjoint.
    mocks.discovery.resolveVerifications.mockResolvedValue([
      makeVerificationAttestation(verifierDid, profileDid),
    ])
    mocks.discovery.resolveAttestations.mockResolvedValue([
      makeGenericAttestation(attesterDid, profileDid, 'great gardener'),
    ])

    renderPublicProfile(profileDid)

    expect(await screen.findByText('Target Profile')).toBeInTheDocument()
    // Verification from /v renders in the verification section.
    expect(await screen.findByText('Verbunden mit 1 Person')).toBeInTheDocument()
    // Generic from /a renders in the attestation section — both visible (union).
    // The claim is wrapped in typographic quotes by the UI, so match on substring.
    expect(await screen.findByText((content) => content.includes('great gardener'))).toBeInTheDocument()
    expect(screen.getByText('1 Bestätigung')).toBeInTheDocument()
  })
})
