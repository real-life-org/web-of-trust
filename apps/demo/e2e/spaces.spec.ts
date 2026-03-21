import { test, expect } from '@playwright/test'
import { createIdentity } from './helpers/identity'
import { createFreshContext, waitForRelayConnected, navigateTo } from './helpers/common'
import { performMutualVerification } from './helpers/verification'

test.describe('Spaces', () => {
  test('create space, invite member, shared notes with CRDT merge, remove member', async ({ browser }) => {
    const { context: aliceCtx, page: alicePage } = await createFreshContext(browser)
    const { context: bobCtx, page: bobPage } = await createFreshContext(browser)

    try {
      // Setup: onboard + verify
      await createIdentity(alicePage, { name: 'Alice', passphrase: 'alice123pw' })
      await createIdentity(bobPage, { name: 'Bob', passphrase: 'bob12345pw' })
      await waitForRelayConnected(alicePage)
      await waitForRelayConnected(bobPage)
      await performMutualVerification(alicePage, bobPage)

      // Alice creates a space
      await navigateTo(alicePage, '/spaces')
      await alicePage.getByText('Erstellen', { exact: true }).click()

      // Fill in space name
      await alicePage.getByPlaceholder('z.B. Gartengruppe, Familie...').fill('Gartengruppe')

      // Submit the create form — find the submit button in the form
      await alicePage.locator('form button[type="submit"], form button:has-text("Erstellen")').last().click()

      // Wait for space detail page
      await expect(alicePage.getByText('Gartengruppe').first()).toBeVisible({ timeout: 10_000 })
      await expect(alicePage.getByText('Mitglieder (1)')).toBeVisible()

      // Alice invites Bob
      await alicePage.getByText('Einladen').click()

      // Select Bob in invite dialog
      await alicePage.getByText('Bob').click()
      await alicePage.getByText('1 einladen').click()

      // Wait for member count to update
      await expect(alicePage.getByText('Mitglieder (2)')).toBeVisible({ timeout: 15_000 })

      // Bob receives the space invite
      await bobPage.getByText('eingeladen').waitFor({ timeout: 30_000 })
      await bobPage.getByText('Space öffnen').click()

      // Bob sees the space detail
      await expect(bobPage.getByText('Gartengruppe').first()).toBeVisible({ timeout: 10_000 })

      // Alice types in the shared notes
      const aliceNotes = alicePage.locator('textarea').last()
      await aliceNotes.fill('Tomaten pflanzen')

      // Bob waits for the CRDT-synced content
      const bobNotes = bobPage.locator('textarea').last()
      await expect(bobNotes).toHaveValue(/Tomaten pflanzen/, { timeout: 30_000 })

      // Bob appends to the notes
      const currentValue = await bobNotes.inputValue()
      await bobNotes.fill(currentValue + ' und Gurken säen')

      // Alice waits for the merged content
      await expect(aliceNotes).toHaveValue(/Tomaten pflanzen und Gurken säen/, { timeout: 30_000 })

      // Both should see the complete text
      await expect(aliceNotes).toHaveValue(/Tomaten pflanzen/)
      await expect(aliceNotes).toHaveValue(/Gurken säen/)

      // Alice removes Bob — use aria-label for the remove button
      await alicePage.getByLabel('Mitglied entfernen').click()

      // Alice sees member count back to 1
      await expect(alicePage.getByText('Mitglieder (1)')).toBeVisible({ timeout: 10_000 })

      // Bob gets redirected away from the space
      await expect(bobPage).toHaveURL(/\/spaces$/, { timeout: 15_000 })
    } finally {
      await aliceCtx.close()
      await bobCtx.close()
    }
  })
})
