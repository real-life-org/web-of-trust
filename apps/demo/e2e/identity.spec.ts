import { test, expect } from '@playwright/test'
import { createIdentity, unlockIdentity, recoverIdentity } from './helpers/identity'
import { createFreshContext } from './helpers/common'

test.describe('Identity Management', () => {
  test('onboarding: generate -> verify -> profile -> protect -> complete', async ({ page }) => {
    await page.goto('/')

    // Step 1: Generate
    await page.getByText('Identität generieren').click()

    // Step 2: Display — capture 12 mnemonic words
    await page.locator('.grid-cols-3').waitFor()
    const wordElements = page.locator('.font-mono.font-medium')
    expect(await wordElements.count()).toBe(12)

    const words: string[] = []
    for (let i = 0; i < 12; i++) {
      const text = await wordElements.nth(i).textContent()
      words.push(text!.trim())
    }
    expect(words.every(w => w.length > 0)).toBe(true)

    // Check security checklist
    await page.getByText('Ich habe alle 12 Magischen Wörter aufgeschrieben').click()
    await page.getByText('Ich habe sie an einem sicheren Ort verwahrt').click()
    await page.getByText('Ich verstehe, dass sie nicht wiederhergestellt werden können').click()

    await page.getByText('Weiter zur Verifizierung').click()

    // Step 3: Verify — type 3 random words
    const labels = page.locator('label:has-text("Wort #")')
    const labelCount = await labels.count()
    expect(labelCount).toBe(3)

    for (let i = 0; i < labelCount; i++) {
      const labelText = await labels.nth(i).textContent()
      const match = labelText?.match(/Wort #(\d+)/)
      expect(match).toBeTruthy()
      const wordIndex = parseInt(match![1], 10) - 1
      await page.locator('input[type="text"]').nth(i).fill(words[wordIndex])
    }

    await page.getByText('Verifizieren', { exact: true }).click()

    // Step 4: Profile
    await page.getByPlaceholder('Dein Name').fill('TestUser')
    await page.getByPlaceholder('Ein kurzer Satz über dich (optional)').fill('E2E Testperson')
    await page.getByText('Weiter', { exact: true }).click()

    // Step 5: Protect
    await page.getByPlaceholder('Mindestens 8 Zeichen').fill('test1234')
    await page.getByPlaceholder('Passwort wiederholen').fill('test1234')
    await page.getByText('Identität schützen').click()

    // Step 6: Complete
    await expect(page.getByText('Geschafft!')).toBeVisible({ timeout: 10_000 })
    const didText = await page.locator('.font-mono.text-xs.break-all').textContent()
    expect(didText).toMatch(/^did:key:z/)

    // Wait for redirect to home
    await page.waitForURL('/', { timeout: 10_000 })
    await expect(page.getByText('Hallo, TestUser!')).toBeVisible({ timeout: 10_000 })
  })

  test('unlock: reload -> passphrase -> logged in', async ({ page }) => {
    const { did } = await createIdentity(page, {
      name: 'UnlockUser',
      passphrase: 'unlock1234',
    })

    await page.reload()

    await unlockIdentity(page, 'unlock1234')

    // After unlock, the greeting shows — may use name or DID fragment
    await expect(page.getByText('Hallo,')).toBeVisible({ timeout: 10_000 })
  })

  test('seed restore: same DID on new device', async ({ page, browser }) => {
    const { mnemonic, did: originalDid } = await createIdentity(page, {
      name: 'RestoreUser',
      passphrase: 'restore1234',
    })

    // Create a new browser context (simulates a new device)
    const { context: newCtx, page: newPage } = await createFreshContext(browser)

    try {
      const { did: restoredDid } = await recoverIdentity(newPage, {
        mnemonic,
        passphrase: 'newpassword1234',
      })

      // DID must be identical — same mnemonic = same identity
      expect(restoredDid).toBe(originalDid)
    } finally {
      await newCtx.close()
    }
  })
})
