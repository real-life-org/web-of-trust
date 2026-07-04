import { test, expect } from '@playwright/test'
import { createIdentity, recoverIdentity } from './helpers/identity'
import { createFreshContext, waitForRelayConnected, navigateTo } from './helpers/common'
import { performMutualVerification } from './helpers/verification'
import { goOffline, goOnline, waitForReconnect } from './helpers/offline'
import { createSpace, inviteMember, acceptSpaceInvite, sendMessage, expectMessage, expectMemberCount, removeMember } from './helpers/spaces'

test.describe('Key Rotation Multi-Device', () => {
  // STILL fixme after the I-READ "Key-available ⇒ replayBlockedByKey" slice. The replay gap
  // (a key arriving via a non-apply path not replaying the blocked-by-key buffer) IS now fixed
  // + adapter-tested (YjsReplayBlockedByKeyGuard / Automerge parity + all key-available paths
  // wired). But live runs show this E2E is blocked UPSTREAM, not by the replay: Device 2's
  // metadata only ever holds gen=[0] — the gen=1 key never reaches it (no key-rotation inbox
  // message, no gen=1 reload), so its blocked-by-key buffer is never populated and there is
  // nothing to replay. The exact break point is still under investigation and differs across
  // environments (in some runs the rotation/distribution never even reaches the relay — removal
  // may not fire → no space-rotate → gen=1 never produced; in others gen=1 is produced on
  // Device 1 but not delivered to Device 2). Separate slice: upstream rotation/distribution to
  // the 2nd device (directive non-goal "Key-Verteilung selbst").
  test.fixme('admin removes member on Device 1, Device 2 can still write and read after key rotation', async ({ browser }) => {
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

  // STILL fixme: same finding as the test above — the I-READ replay fix is in + adapter-tested,
  // but the gen=1 key never reaches Device 2 (metadata stays gen=[0]), so the replay has nothing
  // to do. The exact upstream break point (rotation/distribution never reaching the relay vs.
  // produced-but-not-delivered) is still under investigation. Separate slice.
  test.fixme('Device 2 offline during key rotation — receives new key on reconnect', async ({ browser }) => {
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
