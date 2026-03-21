import { test, expect } from '@playwright/test'
import { createIdentity, recoverIdentity } from './helpers/identity'
import { createFreshContext, waitForRelayConnected, navigateTo } from './helpers/common'
import { performMutualVerification } from './helpers/verification'

test.describe('Multi-Device Sync', () => {
  test('Alice on 2 devices + Bob: personal-doc sync, message routing, space sync', async ({ browser }) => {
    // Phase A: Setup
    const { context: alice1Ctx, page: alice1Page } = await createFreshContext(browser)
    const { context: alice2Ctx, page: alice2Page } = await createFreshContext(browser)
    const { context: bobCtx, page: bobPage } = await createFreshContext(browser)

    try {
      // Alice Device 1: create identity
      const { mnemonic: aliceMnemonic, did: aliceDid } = await createIdentity(alice1Page, {
        name: 'Alice',
        passphrase: 'alice123pw',
      })

      // Bob: create identity
      await createIdentity(bobPage, { name: 'Bob', passphrase: 'bob12345pw' })

      // Wait for relay on both
      await waitForRelayConnected(alice1Page)
      await waitForRelayConnected(bobPage)

      // Alice Device 1 + Bob: mutual verification
      await performMutualVerification(alice1Page, bobPage)

      // Verify Bob is in Alice's contacts on Device 1
      await navigateTo(alice1Page, '/contacts')
      await expect(alice1Page.getByText('Bob')).toBeVisible({ timeout: 10_000 })

      // --- Phase A: Alice Device 2 — recover identity, sync personal doc ---

      // Alice Device 2: recover from mnemonic
      const { did: alice2Did } = await recoverIdentity(alice2Page, {
        mnemonic: aliceMnemonic,
        passphrase: 'alice2password',
      })

      // Same mnemonic = same DID
      expect(alice2Did).toBe(aliceDid)

      // Wait for relay connection on Device 2
      await waitForRelayConnected(alice2Page)

      // Personal-doc sync: Bob should appear in contacts on Device 2
      await navigateTo(alice2Page, '/contacts')
      await expect(alice2Page.getByText('Bob')).toBeVisible({ timeout: 60_000 })

      // --- Phase B: Incoming attestation — both devices receive ---

      // Bob creates attestation for Alice
      await navigateTo(bobPage, '/attestations/new')
      await bobPage.locator('select').selectOption({ label: 'Alice' })
      await bobPage.locator('textarea').fill('Vertrauenswürdig')
      await bobPage.getByRole('button', { name: 'Bestätigung erstellen' }).click()
      await bobPage.waitForURL('/attestations', { timeout: 10_000 })

      // Both of Alice's devices should receive the attestation dialog
      // (Relay routes to ALL WebSocket connections for the same DID)
      await alice1Page.getByText('Neue Bestätigung von').waitFor({ timeout: 30_000 })
      await alice2Page.getByText('Neue Bestätigung von').waitFor({ timeout: 30_000 })

      // Alice Device 1 publishes
      await alice1Page.getByText('Veröffentlichen').click()

      // Alice Device 2's dialog should also close (personal-doc sync updates accepted status)
      // Give it time to sync
      await alice2Page.waitForTimeout(5_000)
      // The dialog should have been dismissed — verify by checking we can navigate
      await navigateTo(alice2Page, '/attestations')
      await expect(alice2Page.getByText('Vertrauenswürdig', { exact: true })).toBeVisible({ timeout: 15_000 })

      // --- Phase C: Space — both devices see it ---

      // Alice Device 1: create a space
      await navigateTo(alice1Page, '/spaces')
      await alice1Page.getByText('Erstellen', { exact: true }).click()
      await alice1Page.getByPlaceholder('z.B. Gartengruppe, Familie...').fill('Familien-Space')
      await alice1Page.locator('form button[type="submit"], form button:has-text("Erstellen")').last().click()

      // Wait for space detail
      await expect(alice1Page.getByText('Familien-Space').first()).toBeVisible({ timeout: 10_000 })

      // Invite Bob
      await alice1Page.getByText('Einladen').click()
      await alice1Page.getByText('Bob').click()
      await alice1Page.getByText('1 einladen').click()
      await expect(alice1Page.getByText('Mitglieder (2)')).toBeVisible({ timeout: 15_000 })

      // Bob receives invite
      await bobPage.getByText('eingeladen').waitFor({ timeout: 30_000 })
      await bobPage.getByText('Space öffnen').click()
      await expect(bobPage.getByText('Familien-Space').first()).toBeVisible({ timeout: 10_000 })

      // Alice Device 2: should see the space (synced via personal doc)
      await navigateTo(alice2Page, '/spaces')
      await expect(alice2Page.getByText('Familien-Space')).toBeVisible({ timeout: 30_000 })
    } finally {
      await alice1Ctx.close()
      await alice2Ctx.close()
      await bobCtx.close()
    }
  })
})
