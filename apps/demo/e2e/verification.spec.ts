import { test, expect } from '@playwright/test'
import { createIdentity } from './helpers/identity'
import { createFreshContext, waitForRelayConnected, navigateTo } from './helpers/common'
import {
  getVerificationCode,
  submitVerificationCode,
  confirmVerificationInFlow,
  confirmIncomingVerification,
  dismissMutualDialog,
} from './helpers/verification'

test.describe('QR Verification', () => {
  test('Alice and Bob verify each other', async ({ browser }) => {
    // Create two isolated browser contexts
    const { context: aliceCtx, page: alicePage } = await createFreshContext(browser)
    const { context: bobCtx, page: bobPage } = await createFreshContext(browser)

    try {
      // Onboard both users
      await createIdentity(alicePage, { name: 'Alice', passphrase: 'alice123pw' })
      await createIdentity(bobPage, { name: 'Bob', passphrase: 'bob12345pw' })

      // Wait for relay connection on both
      await waitForRelayConnected(alicePage)
      await waitForRelayConnected(bobPage)

      // Alice shows her challenge code
      const challengeCode = await getVerificationCode(alicePage)
      expect(challengeCode.length).toBeGreaterThan(10)

      // Bob enters the code manually
      await submitVerificationCode(bobPage, challengeCode)

      // Bob sees "Stehst du vor dieser Person?" with Alice's name
      await bobPage.getByText('Stehst du vor dieser Person?').waitFor({ timeout: 10_000 })
      await expect(bobPage.getByText('Alice')).toBeVisible()

      // Bob confirms
      await confirmVerificationInFlow(bobPage)

      // Bob sees success
      await expect(bobPage.getByText('Verbindung erfolgreich!')).toBeVisible({ timeout: 10_000 })

      // Alice receives the incoming verification dialog
      await confirmIncomingVerification(alicePage)

      // Both should see the mutual friends dialog
      await dismissMutualDialog(alicePage)
      await dismissMutualDialog(bobPage)

      // Verify contacts appear in the contact list
      await navigateTo(alicePage, '/contacts')
      await navigateTo(bobPage, '/contacts')

      await expect(alicePage.getByText('Bob')).toBeVisible({ timeout: 10_000 })
      await expect(bobPage.getByText('Alice')).toBeVisible({ timeout: 10_000 })
    } finally {
      await aliceCtx.close()
      await bobCtx.close()
    }
  })
})
