import { test, expect } from '@playwright/test'
import { createIdentity, recoverIdentity } from './helpers/identity'
import { createFreshContext, waitForRelayConnected, navigateTo } from './helpers/common'
import { performMutualVerification } from './helpers/verification'
import { goOffline, goOnline, waitForReconnect } from './helpers/offline'

test.describe('Key Rotation Multi-Device', () => {
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
      await expect(alice2Page.getByText('Bob')).toBeVisible({ timeout: 60_000 })

      // --- Alice Device 1: create space and invite Bob ---

      await navigateTo(alice1Page, '/spaces')
      await alice1Page.getByText('Erstellen', { exact: true }).click()
      await alice1Page.getByPlaceholder('z.B. Gartengruppe, Familie...').fill('Rotations-Test')
      await alice1Page.locator('form button[type="submit"], form button:has-text("Erstellen")').last().click()

      await expect(alice1Page.getByText('Rotations-Test').first()).toBeVisible({ timeout: 10_000 })

      // Invite Bob
      await alice1Page.getByText('Einladen').click()
      await alice1Page.getByText('Bob').click()
      await alice1Page.getByText('1 einladen').click()
      await expect(alice1Page.getByText('Mitglieder (2)')).toBeVisible({ timeout: 15_000 })

      // Bob accepts
      await bobPage.getByText('eingeladen').waitFor({ timeout: 30_000 })
      await bobPage.getByText('Space öffnen').click()
      await expect(bobPage.getByText('Rotations-Test').first()).toBeVisible({ timeout: 10_000 })

      // --- Alice Device 1: write something before rotation ---

      const alice1Notes = alice1Page.locator('textarea').last()
      await alice1Notes.fill('Vor der Rotation')

      // Bob sees it
      const bobNotes = bobPage.locator('textarea').last()
      await expect(bobNotes).toHaveValue(/Vor der Rotation/, { timeout: 30_000 })

      // Device 2 sees the space
      await navigateTo(alice2Page, '/spaces')
      await expect(alice2Page.getByText('Rotations-Test')).toBeVisible({ timeout: 30_000 })
      await alice2Page.getByText('Rotations-Test').click()

      // Device 2 sees the notes via state exchange
      // (State exchange sends full Y.Doc state at connect time)
      const alice2Notes = alice2Page.locator('textarea').last()
      await expect(alice2Notes).toHaveValue(/Vor der Rotation/, { timeout: 60_000 })

      // --- KEY ROTATION: Alice Device 1 removes Bob ---

      await alice1Page.getByLabel('Mitglied entfernen').click()
      await expect(alice1Page.getByText('Mitglieder (1)')).toBeVisible({ timeout: 10_000 })

      // Wait for key rotation to propagate
      await alice1Page.waitForTimeout(3_000)

      // --- After rotation: Alice Device 1 writes with new key ---

      await alice1Notes.fill('Nach der Rotation — neuer Key')

      // --- Device 2 should still be able to read (has new key via relay) ---

      await expect(alice2Notes).toHaveValue(/Nach der Rotation/, { timeout: 30_000 })

      // --- Device 2 writes with new key ---

      const currentValue = await alice2Notes.inputValue()
      await alice2Notes.fill(currentValue + ' — Device 2 schreibt')

      // Device 1 receives Device 2's write (both using new key)
      await expect(alice1Notes).toHaveValue(/Device 2 schreibt/, { timeout: 30_000 })

    } finally {
      await alice1Ctx.close()
      await alice2Ctx.close()
      await bobCtx.close()
    }
  })

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
      await expect(alice2Page.getByText('Bob')).toBeVisible({ timeout: 60_000 })

      // Create space + invite Bob + write initial content
      await navigateTo(alice1Page, '/spaces')
      await alice1Page.getByText('Erstellen', { exact: true }).click()
      await alice1Page.getByPlaceholder('z.B. Gartengruppe, Familie...').fill('Offline-Rotation')
      await alice1Page.locator('form button[type="submit"], form button:has-text("Erstellen")').last().click()
      await expect(alice1Page.getByText('Offline-Rotation').first()).toBeVisible({ timeout: 10_000 })

      // Write initial content BEFORE inviting Bob
      const alice1Notes = alice1Page.locator('textarea').last()
      await alice1Notes.fill('Initialer Content')

      await alice1Page.getByText('Einladen').click()
      await alice1Page.getByText('Bob').click()
      await alice1Page.getByText('1 einladen').click()
      await expect(alice1Page.getByText('Mitglieder (2)')).toBeVisible({ timeout: 15_000 })

      // Bob accepts
      await bobPage.getByText('eingeladen').waitFor({ timeout: 30_000 })
      await bobPage.getByText('Space öffnen').click()

      // Bob sees the content
      const bobNotes = bobPage.locator('textarea').last()
      await expect(bobNotes).toHaveValue(/Initialer Content/, { timeout: 30_000 })

      // Device 2 sees the space and content (sync-request + state exchange)
      await navigateTo(alice2Page, '/spaces')
      await expect(alice2Page.getByText('Offline-Rotation')).toBeVisible({ timeout: 60_000 })
      await alice2Page.getByText('Offline-Rotation').click()
      const alice2Notes = alice2Page.locator('textarea').last()
      await expect(alice2Notes).toHaveValue(/Initialer Content/, { timeout: 60_000 })

      // --- Device 2 goes OFFLINE (has the space and content, will miss key rotation) ---
      await goOffline(alice2Ctx)

      // --- Device 1 removes Bob (key rotation while Device 2 offline) ---
      await alice1Page.getByLabel('Mitglied entfernen').click()
      await expect(alice1Page.getByText('Mitglieder (1)')).toBeVisible({ timeout: 10_000 })
      await alice1Page.waitForTimeout(2_000)

      // Device 1 writes with the NEW key (gen 1)
      await alice1Notes.fill('Geschrieben mit neuem Key')

      // Wait for Vault pushes to complete:
      // - PersonalDoc with Gen 1 key (flushPersonalDoc in removeMember)
      // - Space snapshot re-encrypted with Gen 1 (_scheduleVaultImmediate)
      await alice1Page.waitForTimeout(8_000)

      // --- Device 2 comes back ONLINE ---
      await goOnline(alice2Ctx)
      // Navigate to trigger reconnect (same pattern as offline-multi-device.spec.ts)
      await navigateTo(alice2Page, '/')
      await waitForReconnect(alice2Page)

      // Navigate back to space
      await navigateTo(alice2Page, '/spaces')
      await alice2Page.getByText('Offline-Rotation').click()

      // Device 2 receives queued messages: key-rotation + content update
      const alice2NotesAfter = alice2Page.locator('textarea').last()
      await expect(alice2NotesAfter).toHaveValue(/Geschrieben mit neuem Key/, { timeout: 60_000 })

      // Device 2 can WRITE with the new key
      const currentValue = await alice2NotesAfter.inputValue()
      await alice2NotesAfter.fill(currentValue + ' — D2 nach Reconnect')
      await expect(alice1Notes).toHaveValue(/D2 nach Reconnect/, { timeout: 30_000 })

    } finally {
      await alice1Ctx.close()
      await alice2Ctx.close()
      await bobCtx.close()
    }
  })
})
