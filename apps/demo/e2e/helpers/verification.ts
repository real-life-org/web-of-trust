import type { Page } from '@playwright/test'
import { navigateTo } from './common'

/**
 * On the /verify page, wait for the QR code to render and copy the
 * challenge code to the clipboard, then return it.
 */
export async function getVerificationCode(page: Page): Promise<string> {
  await navigateTo(page, '/verify')
  // Wait for QR image to render
  await page.locator('img[alt="QR Code"]').waitFor({ timeout: 15_000 })

  // Click "Code kopieren"
  await page.getByText('Code kopieren').click()

  // Read from clipboard
  const code = await page.evaluate(() => navigator.clipboard.readText())
  return code
}

/**
 * On Bob's /verify page, use the manual code entry to submit a challenge code.
 */
export async function submitVerificationCode(
  page: Page,
  code: string,
): Promise<void> {
  await navigateTo(page, '/verify')

  // Click "Code manuell eingeben" to reveal textarea
  await page.getByText('Code manuell eingeben').click()

  // Fill the textarea and submit
  await page.locator('textarea').fill(code)
  await page.getByText('Code prüfen').click()
}

/**
 * Confirm the verification in the VerificationFlow confirm screen.
 * This is the "Stehst du vor dieser Person?" question inside the flow.
 */
export async function confirmVerificationInFlow(page: Page): Promise<void> {
  await page.getByText('Stehst du vor dieser Person?').waitFor({ timeout: 20_000 })
  // The confirm button inside the VerificationFlow
  await page.getByRole('button', { name: 'Bestätigen' }).click()
}

/**
 * Wait for and confirm the IncomingVerificationDialog overlay.
 * This appears globally when a verification message arrives via relay.
 */
export async function confirmIncomingVerification(page: Page): Promise<void> {
  // Wait for the global overlay dialog
  await page.getByText('Stehst du vor dieser Person?').waitFor({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Bestätigen' }).click()
}

/**
 * Wait for the mutual verification dialog and dismiss it.
 */
export async function dismissMutualDialog(page: Page): Promise<void> {
  await page.getByText('seid verbunden!').waitFor({ timeout: 20_000 })
  // The X close button is `button.absolute.top-3.right-3` inside the dialog
  await page.locator('.fixed button.absolute').click()
  // Wait for dialog to disappear
  await page.getByText('seid verbunden!').waitFor({ state: 'hidden', timeout: 5_000 })
}

/**
 * Perform the complete mutual verification flow between Alice and Bob.
 * Both pages should already be logged in and relay-connected.
 *
 * After this, Alice and Bob are mutual contacts.
 */
export async function performMutualVerification(
  alicePage: Page,
  bobPage: Page,
): Promise<void> {
  // Alice shows her code
  const code = await getVerificationCode(alicePage)

  // Bob enters the code manually
  await submitVerificationCode(bobPage, code)

  // Bob confirms "Stehst du vor dieser Person?"
  await confirmVerificationInFlow(bobPage)

  // Bob sees success
  await bobPage.getByText('Verbindung erfolgreich!').waitFor({ timeout: 10_000 })

  // Alice gets the incoming verification dialog and confirms
  await confirmIncomingVerification(alicePage)

  // Both should see the mutual friends dialog — dismiss on both
  await dismissMutualDialog(alicePage)
  await dismissMutualDialog(bobPage)
}
