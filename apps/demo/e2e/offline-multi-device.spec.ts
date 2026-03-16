import { test, expect } from '@playwright/test'
import { createIdentity, recoverIdentity } from './helpers/identity'
import { createFreshContext, waitForRelayConnected, navigateTo } from './helpers/common'
import { performMutualVerification } from './helpers/verification'
import { goOffline, goOnline, waitForReconnect } from './helpers/offline'

test.describe('Offline Multi-Device', () => {
  test('Device 2 offline, Device 1 edits profile → Device 2 reconnects → synced', async ({ browser }) => {
    // Phase 1: Setup — Alice on Device 1, verify with Bob, then restore on Device 2
    const { context: alice1Ctx, page: alice1Page } = await createFreshContext(browser)
    const { context: bobCtx, page: bobPage } = await createFreshContext(browser)

    let aliceMnemonic: string

    const { mnemonic } = await createIdentity(alice1Page, { name: 'Alice', passphrase: 'alice123pw' })
    aliceMnemonic = mnemonic

    await createIdentity(bobPage, { name: 'Bob', passphrase: 'bob12345pw' })

    await waitForRelayConnected(alice1Page)
    await waitForRelayConnected(bobPage)

    await performMutualVerification(alice1Page, bobPage)

    // Verify Bob is in contacts on Device 1
    await navigateTo(alice1Page, '/contacts')
    await expect(alice1Page.getByText('Bob')).toBeVisible({ timeout: 10_000 })

    // Wait for vault sync
    await alice1Page.waitForTimeout(5_000)

    // Alice Device 2: restore from seed
    const { context: alice2Ctx, page: alice2Page } = await createFreshContext(browser)

    try {
      await recoverIdentity(alice2Page, {
        mnemonic: aliceMnemonic,
        passphrase: 'device2pw123',
      })

      await waitForReconnect(alice2Page)

      // Wait for personal-doc sync — Bob should appear
      await navigateTo(alice2Page, '/contacts')
      await expect(alice2Page.getByText('Bob')).toBeVisible({ timeout: 30_000 })

      // --- Phase 2: Device 2 goes offline, Device 1 makes changes ---
      await goOffline(alice2Ctx)
      await alice2Page.waitForTimeout(2_000)

      // Device 1: edit profile
      await navigateTo(alice1Page, '/identity')
      await alice1Page.getByText('Profil bearbeiten').click()
      await alice1Page.getByPlaceholder('Dein Name').clear()
      await alice1Page.getByPlaceholder('Dein Name').fill('Alice Updated')
      await alice1Page.getByPlaceholder('Ein kurzer Satz über dich').fill('Geändert während Device 2 offline')
      await alice1Page.getByText('Speichern').click()
      await alice1Page.waitForTimeout(3_000)

      // Verify change on Device 1
      await navigateTo(alice1Page, '/')
      await expect(alice1Page.getByText('Hallo, Alice Updated')).toBeVisible({ timeout: 10_000 })

      // --- Phase 3: Device 2 comes back online → should sync ---
      await goOnline(alice2Ctx)
      await navigateTo(alice2Page, '/')
      await waitForReconnect(alice2Page)

      // Device 2 should see the updated name (via personal-doc sync)
      await expect(alice2Page.getByText('Hallo, Alice Updated')).toBeVisible({ timeout: 30_000 })

      // Contacts should still be there (merge, not replace)
      await navigateTo(alice2Page, '/contacts')
      await expect(alice2Page.getByText('Bob')).toBeVisible({ timeout: 10_000 })
    } finally {
      await alice1Ctx.close()
      await alice2Ctx.close()
      await bobCtx.close()
    }
  })
})
