import { test, expect, type Page } from '@playwright/test'
import { createIdentity, recoverIdentity } from './helpers/identity'
import { createFreshContext, waitForRelayConnected, navigateTo } from './helpers/common'
import { performMutualVerification } from './helpers/verification'
import { goOffline, goOnline, waitForReconnect } from './helpers/offline'
import { createSpace, inviteMember, acceptSpaceInvite, sendMessage, expectMessage, expectMemberCount, removeMember } from './helpers/spaces'

/**
 * Mode-1 test hygiene: a freshly RECOVERED 2nd device re-shows the mutual-verification dialog
 * (CRDT-synced, observer-based) as a full-screen backdrop that intercepts later clicks. The
 * PRODUCT fix is the separate (loop-ready) dialog-lifecycle slice (no re-show from history +
 * synced dismiss); this rotation E2E tests ROTATION, so we tolerantly dismiss the dialog if it
 * is present (role-based selector, close-if-visible, no hard wait). Stays green in BOTH worlds
 * (with or without the dialog slice), merge order irrelevant.
 */
async function dismissVerificationDialogIfPresent(page: Page): Promise<void> {
  const closeBtn = page.getByRole('button', { name: /Dialog schließen|Close dialog/i })
  const visible = await closeBtn.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true).catch(() => false)
  if (visible) await closeBtn.click().catch(() => { /* raced its own dismiss — fine */ })
}

test.describe('Key Rotation Multi-Device', () => {
  // Space-Rotation gen=1 multi-device — now GREEN. Two stacked bugs were fixed: (Mode 2, the
  // protocol bug) the capability signing seed travels ONLY in the key-rotation message, which the
  // content key overtakes on Device 2 → the rotation classifies as a duplicate and the seed was
  // discarded → read-only. I-CAP (this slice) imports it content-bound on the duplicate path.
  // (Mode 1, test hygiene) the recovered device re-shows the verification dialog → dismissed
  // tolerantly below (product fix = the separate dialog-lifecycle slice). #226's I-READ replay
  // makes the gen=1 content readable.
  test('admin removes member on Device 1, Device 2 can still write and read after key rotation', async ({ browser }) => {
    // Setup: Alice (2 devices) + Bob
    const { context: alice1Ctx, page: alice1Page } = await createFreshContext(browser)
    const { context: alice2Ctx, page: alice2Page } = await createFreshContext(browser)
    const { context: bobCtx, page: bobPage } = await createFreshContext(browser)

    try {
      // Alice Device 1: create identity
      const { mnemonic: aliceMnemonic } = await createIdentity(alice1Page, {
        name: 'Alice',
        passphrase: 'alice123pw',
      })

      // Bob: create identity
      await createIdentity(bobPage, { name: 'Bob', passphrase: 'bob12345pw' })

      await waitForRelayConnected(alice1Page)
      await waitForRelayConnected(bobPage)

      // Mutual verification
      await performMutualVerification(alice1Page, bobPage)

      // Alice Device 2: recover from mnemonic
      await recoverIdentity(alice2Page, {
        mnemonic: aliceMnemonic,
        passphrase: 'alice2password',
      })
      await waitForRelayConnected(alice2Page)

      // Wait for contacts to sync to Device 2
      await navigateTo(alice2Page, '/contacts')
      // Contact LINK specifically (the loose getByText('Bob') also matches Device 2's
      // "Du und Bob seid verbunden!" verification dialog → strict-mode 2-element flake).
      await expect(alice2Page.getByRole('link', { name: 'Bob' })).toBeVisible({ timeout: 60_000 })

      // --- Alice Device 1: create space and invite Bob ---

      await createSpace(alice1Page, 'Rotations-Test')

      // Invite Bob
      await inviteMember(alice1Page, 'Bob')
      await expectMemberCount(alice1Page, 2)

      // Bob accepts
      await acceptSpaceInvite(bobPage)
      await expect(bobPage.getByText('Rotations-Test').first()).toBeVisible({ timeout: 10_000 })

      // --- Alice Device 1: write something before rotation ---

      await sendMessage(alice1Page, 'Vor der Rotation')

      // Bob sees it
      await expectMessage(bobPage, 'Vor der Rotation')

      // Device 2 sees the space
      await navigateTo(alice2Page, '/chats')
      // Mode-1 hygiene: dismiss the re-shown verification dialog (full-screen backdrop) that would
      // otherwise intercept the space click on the recovered device.
      await dismissVerificationDialogIfPresent(alice2Page)
      await expect(alice2Page.getByText('Rotations-Test')).toBeVisible({ timeout: 30_000 })
      await alice2Page.getByText('Rotations-Test').click()

      // Device 2 sees the message
      await expectMessage(alice2Page, 'Vor der Rotation', 60_000)

      // --- KEY ROTATION: Alice Device 1 removes Bob ---

      await removeMember(alice1Page)
      await expectMemberCount(alice1Page, 1)

      // Wait for key rotation to propagate
      await alice1Page.waitForTimeout(3_000)

      // --- After rotation: Alice Device 1 writes with new key ---

      await sendMessage(alice1Page, 'Nach der Rotation — neuer Key')

      // --- Device 2 should still be able to read (has new key via relay) ---

      await expectMessage(alice2Page, 'Nach der Rotation', 30_000)

      // --- Device 2 writes with new key ---

      await sendMessage(alice2Page, 'Device 2 schreibt')

      // Device 1 receives Device 2's write (both using new key)
      await expectMessage(alice1Page, 'Device 2 schreibt')

    } finally {
      await alice1Ctx.close()
      await alice2Ctx.close()
      await bobCtx.close()
    }
  })

  // Offline variant — same race class on reconnect (the content key reloads before the retained
  // key-rotation is re-delivered → duplicate → I-CAP imports the capability). Green via the same
  // I-CAP fix + Mode-1 dialog hygiene.
  test('Device 2 offline during key rotation — receives new key on reconnect', async ({ browser }) => {
    const { context: alice1Ctx, page: alice1Page } = await createFreshContext(browser)
    const { context: alice2Ctx, page: alice2Page } = await createFreshContext(browser)
    const { context: bobCtx, page: bobPage } = await createFreshContext(browser)

    try {
      // Setup: Alice (2 devices) + Bob, verified, in a shared space
      const { mnemonic: aliceMnemonic } = await createIdentity(alice1Page, {
        name: 'Alice',
        passphrase: 'alice123pw',
      })
      await createIdentity(bobPage, { name: 'Bob', passphrase: 'bob12345pw' })
      await waitForRelayConnected(alice1Page)
      await waitForRelayConnected(bobPage)
      await performMutualVerification(alice1Page, bobPage)

      // Alice Device 2: recover
      await recoverIdentity(alice2Page, {
        mnemonic: aliceMnemonic,
        passphrase: 'alice2password',
      })
      await waitForRelayConnected(alice2Page)
      await navigateTo(alice2Page, '/contacts')
      // Contact LINK specifically (the loose getByText('Bob') also matches Device 2's
      // "Du und Bob seid verbunden!" verification dialog → strict-mode 2-element flake).
      await expect(alice2Page.getByRole('link', { name: 'Bob' })).toBeVisible({ timeout: 60_000 })

      // Create space + invite Bob + write initial content
      await createSpace(alice1Page, 'Offline-Rotation')

      // Write initial content BEFORE inviting Bob
      await sendMessage(alice1Page, 'Initialer Content')

      await inviteMember(alice1Page, 'Bob')
      await expectMemberCount(alice1Page, 2)

      // Bob accepts
      await acceptSpaceInvite(bobPage)

      // Bob sees the content
      await expectMessage(bobPage, 'Initialer Content')

      // Device 2 sees the space and content
      await navigateTo(alice2Page, '/chats')
      await dismissVerificationDialogIfPresent(alice2Page)
      await expect(alice2Page.getByText('Offline-Rotation')).toBeVisible({ timeout: 60_000 })
      await alice2Page.getByText('Offline-Rotation').click()
      await expectMessage(alice2Page, 'Initialer Content', 60_000)

      // --- Device 2 goes OFFLINE ---
      await goOffline(alice2Ctx)

      // --- Device 1 removes Bob (key rotation while Device 2 offline) ---
      await removeMember(alice1Page)
      await expectMemberCount(alice1Page, 1)

      // Device 1 writes with the NEW key (gen 1)
      await sendMessage(alice1Page, 'Geschrieben mit neuem Key')

      // Wait for Vault pushes to complete
      await alice1Page.waitForTimeout(8_000)

      // --- Device 2 comes back ONLINE ---
      await goOnline(alice2Ctx)
      await navigateTo(alice2Page, '/')
      await waitForReconnect(alice2Page)

      // Navigate back to space
      await navigateTo(alice2Page, '/chats')
      await dismissVerificationDialogIfPresent(alice2Page)
      await alice2Page.getByText('Offline-Rotation').click()

      // Device 2 receives queued messages: key-rotation + content update
      await expectMessage(alice2Page, 'Geschrieben mit neuem Key', 60_000)

      // Device 2 can WRITE with the new key
      await sendMessage(alice2Page, 'D2 nach Reconnect')
      await expectMessage(alice1Page, 'D2 nach Reconnect')

    } finally {
      await alice1Ctx.close()
      await alice2Ctx.close()
      await bobCtx.close()
    }
  })
})
