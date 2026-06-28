/**
 * Step 4 (1.B.3-admin-management, VE-4) — SpaceForm multi-admin wiring.
 *
 * UX-neutral logic/visibility migration onto the real active admin list
 * (`space.admins`, Sync 005 Z.111-130). Asserts:
 *   - Admin-Badge for ALL active admins, not just the creator.
 *   - Remove-button gated on `space.admins.includes(myDid)` (not isCreator).
 *   - NEW "promote to admin" button per non-admin active member, visible only
 *     when the viewer is an admin (`space.admins.includes(myDid)`).
 *   - Promote threads through useSpaces.promoteToAdmin (→ SpacesWorkflow port).
 *   - addMember/invite stays open to any member (Sync 005 Z.62, unchanged).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const ME = 'did:key:z6MkMe'
const CREATOR = 'did:key:z6MkCreator'
const MEMBER_B = 'did:key:z6MkMemberB'
const MEMBER_C = 'did:key:z6MkMemberC'
const SPACE_ID = 'space-1'

interface MockSpace {
  id: string
  name: string
  members: string[]
  admins: string[]
  createdBy?: string
}

const mockSpace: MockSpace = {
  id: SPACE_ID,
  name: 'Test Space',
  members: [CREATOR, ME, MEMBER_B, MEMBER_C],
  admins: [CREATOR, ME],
  createdBy: CREATOR,
}

const promoteToAdmin = vi.fn(async () => {})
const removeMember = vi.fn(async () => {})
const inviteMember = vi.fn(async () => {})

let viewerDid = ME

vi.mock('../src/hooks', () => ({
  useSpaces: () => ({
    createSpace: vi.fn(),
    getSpace: vi.fn(async () => mockSpace),
    updateSpace: vi.fn(async () => {}),
    inviteMember,
    removeMember,
    promoteToAdmin,
    leaveSpace: vi.fn(async () => {}),
    spaces: [mockSpace],
  }),
  useContacts: () => ({
    activeContacts: [
      { did: CREATOR, name: 'Creator', avatar: undefined },
      { did: MEMBER_B, name: 'Bob', avatar: undefined },
      { did: MEMBER_C, name: 'Carol', avatar: undefined },
    ],
  }),
  useLocalIdentity: () => ({ profile: { name: 'Me' } }),
}))

vi.mock('../src/context', () => ({
  useIdentity: () => ({ did: viewerDid }),
}))

import { SpaceForm } from '../src/components/spaces/SpaceForm'
import { LanguageProvider } from '../src/i18n'

function renderForm() {
  return render(
    <LanguageProvider>
      <MemoryRouter initialEntries={[`/chats/${SPACE_ID}/edit`]}>
        <Routes>
          <Route path="/chats/:spaceId/edit" element={<SpaceForm mode="edit" />} />
        </Routes>
      </MemoryRouter>
    </LanguageProvider>,
  )
}

describe('SpaceForm multi-admin wiring (Step 4 / VE-4)', () => {
  beforeEach(() => {
    // Force German so the i18n aria labels are deterministic under happy-dom.
    localStorage.setItem('wot-language', 'de')
    viewerDid = ME
    promoteToAdmin.mockClear()
    removeMember.mockClear()
    inviteMember.mockClear()
  })

  it('shows an Admin badge for every active admin, not just the creator', async () => {
    renderForm()
    await waitFor(() => expect(screen.getAllByText('Admin').length).toBeGreaterThanOrEqual(2))
    // Two admins (CREATOR + ME) → two Admin badges.
    expect(screen.getAllByText('Admin')).toHaveLength(2)
  })

  it('shows the remove-button for an admin viewer (gated on admins.includes(myDid))', async () => {
    viewerDid = ME // ME is an admin but NOT the creator
    renderForm()
    await waitFor(() => screen.getByText(/Mitglieder/))
    // Remove buttons for the other members (everyone except self).
    const removeButtons = screen.getAllByLabelText('Mitglied entfernen')
    expect(removeButtons.length).toBeGreaterThan(0)
  })

  it('hides remove + promote controls when the viewer is a non-admin member', async () => {
    viewerDid = MEMBER_B // active member, but NOT an admin
    renderForm()
    await waitFor(() => screen.getByText(/Mitglieder/))
    expect(screen.queryByLabelText('Mitglied entfernen')).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Admin/i)).toBeNull()
    expect(promoteToAdmin).not.toHaveBeenCalled()
  })

  it('renders a promote-button for each non-admin active member when the viewer is an admin', async () => {
    viewerDid = ME
    renderForm()
    await waitFor(() => screen.getByText(/Mitglieder/))
    // MEMBER_B and MEMBER_C are non-admin members → two promote buttons.
    const promoteButtons = screen.getAllByLabelText('Zum Admin befördern')
    expect(promoteButtons).toHaveLength(2)
  })

  it('threads promote through useSpaces.promoteToAdmin', async () => {
    viewerDid = ME
    renderForm()
    await waitFor(() => screen.getByText(/Mitglieder/))
    const promoteButtons = screen.getAllByLabelText('Zum Admin befördern')
    fireEvent.click(promoteButtons[0])
    await waitFor(() => expect(promoteToAdmin).toHaveBeenCalledTimes(1))
    expect(promoteToAdmin).toHaveBeenCalledWith(SPACE_ID, expect.stringMatching(/^did:key:/))
  })
})
