import type { Page } from '@playwright/test'

interface CreateIdentityOptions {
  name: string
  passphrase: string
  bio?: string
}

interface CreateIdentityResult {
  mnemonic: string
  did: string
}

/**
 * Walk through the full onboarding flow and return the mnemonic + DID.
 *
 * Steps: generate -> display (capture words) -> verify (3 random words) ->
 *        profile (name, bio) -> protect (passphrase) -> complete
 */
export async function createIdentity(
  page: Page,
  opts: CreateIdentityOptions,
): Promise<CreateIdentityResult> {
  await page.goto('/')

  // Step 1: Generate
  await page.getByText('Identität generieren').click()

  // Step 2: Display — capture mnemonic words
  await page.locator('.grid-cols-3').waitFor()
  const wordElements = page.locator('.font-mono.font-medium')
  const wordCount = await wordElements.count()
  const words: string[] = []
  for (let i = 0; i < wordCount; i++) {
    const text = await wordElements.nth(i).textContent()
    words.push(text!.trim())
  }
  const mnemonic = words.join(' ')

  // Check all 3 security checklist items
  await page.getByText('Ich habe alle 12 Magischen Wörter aufgeschrieben').click()
  await page.getByText('Ich habe sie an einem sicheren Ort verwahrt').click()
  await page.getByText('Ich verstehe, dass sie nicht wiederhergestellt werden können').click()

  // Continue to verify
  await page.getByText('Weiter zur Verifizierung').click()

  // Step 3: Verify — parse which words are requested and type them
  const labels = page.locator('label:has-text("Wort #")')
  const labelCount = await labels.count()
  for (let i = 0; i < labelCount; i++) {
    const labelText = await labels.nth(i).textContent()
    // Parse "Wort #N" to get the 1-based index
    const match = labelText?.match(/Wort #(\d+)/)
    if (match) {
      const wordIndex = parseInt(match[1], 10) - 1 // 0-based
      const input = page.locator('input[type="text"]').nth(i)
      await input.fill(words[wordIndex])
    }
  }

  await page.getByText('Verifizieren', { exact: true }).click()

  // Step 4: Profile
  await page.getByPlaceholder('Dein Name').fill(opts.name)
  if (opts.bio) {
    await page.getByPlaceholder('Ein kurzer Satz über dich (optional)').fill(opts.bio)
  }
  await page.getByText('Weiter', { exact: true }).click()

  // Step 5: Protect — passphrase
  await page.getByPlaceholder('Mindestens 8 Zeichen').fill(opts.passphrase)
  await page.getByPlaceholder('Passwort wiederholen').fill(opts.passphrase)
  await page.getByText('Identität schützen').click()

  // Step 6: Complete — capture DID
  await page.getByText('Geschafft!').waitFor({ timeout: 10_000 })
  const didElement = page.locator('.font-mono.text-xs.break-all')
  const did = (await didElement.textContent())!.trim()

  // Wait for redirect to home
  await page.waitForURL('/', { timeout: 10_000 })

  return { mnemonic, did }
}

/**
 * Unlock an existing identity by entering the passphrase.
 * Assumes the unlock screen is visible.
 */
export async function unlockIdentity(
  page: Page,
  passphrase: string,
): Promise<void> {
  await page.getByText('Willkommen zurück!').waitFor({ timeout: 10_000 })
  await page.getByPlaceholder('Dein Passwort').fill(passphrase)
  await page.getByText('Entsperren', { exact: true }).click()
}

/**
 * Recover identity from mnemonic. Assumes we're on the unlock screen
 * or navigates to /.
 */
export async function recoverIdentity(
  page: Page,
  opts: { mnemonic: string; passphrase: string },
): Promise<{ did: string }> {
  await page.goto('/')

  // Click recovery link — different text on unlock screen vs onboarding screen
  const unlockLink = page.getByText('Identität mit Magischen Wörtern wiederherstellen')
  const onboardingLink = page.getByText('Identität importieren')

  // Wait for either link to appear
  await Promise.race([
    unlockLink.waitFor({ timeout: 10_000 }),
    onboardingLink.waitFor({ timeout: 10_000 }),
  ])

  if (await unlockLink.isVisible()) {
    await unlockLink.click()
  } else {
    await onboardingLink.click()
  }

  // Step 1: Import — enter mnemonic
  await page.locator('textarea').fill(opts.mnemonic)
  await page.getByText('Weiter', { exact: true }).click()

  // Step 2: Protect — set new passphrase
  await page.getByPlaceholder('Mindestens 8 Zeichen').waitFor()
  await page.getByPlaceholder('Mindestens 8 Zeichen').fill(opts.passphrase)
  await page.getByPlaceholder('Passwort wiederholen').fill(opts.passphrase)
  await page.getByText('Identität wiederherstellen').click()

  // Step 3: Complete
  await page.getByText('Wiederherstellung erfolgreich!').waitFor({ timeout: 15_000 })
  const didElement = page.locator('.font-mono.text-xs.break-all')
  const did = (await didElement.textContent())!.trim()

  // Wait for redirect
  await page.waitForURL('/', { timeout: 10_000 })

  return { did }
}
