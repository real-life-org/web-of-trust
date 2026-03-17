import { test, expect } from '@playwright/test'
import { createIdentity } from './helpers/identity'
import { createFreshContext, navigateTo, waitForRelayConnected } from './helpers/common'
import { performMutualVerification } from './helpers/verification'

test.describe('Identity Reset — no data leaks after logout', () => {
  test('new identity has no contacts or profile from previous identity', async ({ browser }) => {
    const { context: ctx, page } = await createFreshContext(browser)

    try {
      // --- Identity A: create and populate ---
      const { did: didA } = await createIdentity(page, {
        name: 'UserA',
        bio: 'I am User A',
        passphrase: 'userA1234',
      })

      // Wait for relay so profile syncs
      await waitForRelayConnected(page)

      // Create a second context for a contact
      const { context: bobCtx, page: bobPage } = await createFreshContext(browser)
      try {
        await createIdentity(bobPage, {
          name: 'BobContact',
          passphrase: 'bob123456',
        })
        await waitForRelayConnected(bobPage)

        // Mutual verification — creates contacts + verifications
        await performMutualVerification(page, bobPage)

        // Verify: UserA has BobContact in contacts
        await navigateTo(page, '/contacts')
        await expect(page.getByText('BobContact')).toBeVisible({ timeout: 10_000 })
      } finally {
        await bobCtx.close()
      }

      // --- Logout ---
      await navigateTo(page, '/identity')

      // Open "Details & Wartung" section first
      await page.getByText('Details & Wartung').click()

      // Click logout button
      await page.getByText('Ausloggen').click()

      // Confirm deletion
      await page.getByText('Ja, ausloggen').click()

      // Wait for redirect to onboarding
      await page.waitForURL('/', { timeout: 15_000 })

      // --- Identity B: create fresh ---
      const { did: didB } = await createIdentity(page, {
        name: 'UserB',
        passphrase: 'userB1234',
      })

      // DIDs must be different
      expect(didB).not.toBe(didA)

      // Wait for app to fully initialize
      await expect(page.getByText('Hallo, UserB!')).toBeVisible({ timeout: 10_000 })

      // Navigate to contacts — must be empty
      await navigateTo(page, '/contacts')
      await expect(page.getByText('BobContact')).not.toBeVisible({ timeout: 3_000 })

      // Navigate to identity — must show UserB, not UserA
      await navigateTo(page, '/identity')
      await expect(page.getByText('UserB')).toBeVisible()
      await expect(page.getByText('UserA')).not.toBeVisible()
      await expect(page.getByText('I am User A')).not.toBeVisible()
    } finally {
      await ctx.close()
    }
  })
})
