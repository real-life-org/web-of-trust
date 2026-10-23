// Acceptance "two phones" over the VTI mediator (TRANSPORT.md "The VTI mediator"): the real adapter, the
// real library, the real wire and the library's mediator adapter per relationship, over the mediator
// double in the page (real TSP and DIDComm crypto). The encounter with delivery hints (Noah learns
// Jonas's hint from Jonas's sent card: the optical leg), a message each way, a block. Functional checks,
// no baselines.
import { expect, test, type Page } from '@playwright/test'

async function pair(page: Page) {
  await page.setViewportSize({ width: 900, height: 960 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto(`/?${new URLSearchParams({ scenario: 'encounter', theme: 'light', carrier: 'mediator' }).toString()}`)
  const jonas = page.frameLocator('iframe[name=jonas]')
  const noah = page.frameLocator('iframe[name=noah]')
  await expect(jonas.getByRole('heading', { name: 'Contacts' })).toBeVisible({ timeout: 30_000 })
  await expect(noah.getByRole('heading', { name: 'Contacts' })).toBeVisible({ timeout: 30_000 })
  return { jonas, noah }
}

const composer = (f: ReturnType<Page['frameLocator']>, name: string) => f.getByRole('textbox', { name: `Message ${name}` })

test('two phones over the mediator: encounter with hints, a message each way, a block', async ({ page }) => {
  const { jonas, noah } = await pair(page)
  // configured, nothing carried yet
  await expect(jonas.getByText('Online · Mediator set up', { exact: true })).toBeVisible()

  // Noah shows, Jonas scans: Jonas's card answer carries his hint; Jonas carries the relationship at once
  await noah.getByRole('button', { name: 'Verify in person' }).click()
  await expect(noah.getByRole('img', { name: 'Your verification code' })).toBeVisible()
  await jonas.getByRole('button', { name: 'Verify in person' }).click()
  await jonas.getByRole('button', { name: 'Scan code' }).click()
  await jonas.getByRole('button', { name: 'Yes, verify Noah' }).click()
  await expect(jonas.getByRole('heading', { name: 'Noah Lindqvist verified' })).toBeVisible()
  // the bundle waits at the mediator until Noah knows Jonas's identities: the optical leg
  await page.getByRole('button', { name: '+1 min' }).click()
  await jonas.getByRole('button', { name: 'Show code' }).click()
  await expect(jonas.getByRole('heading', { name: 'Same encounter, optically' })).toBeVisible()
  await noah.getByRole('button', { name: 'Scan code' }).click()
  await noah.getByRole('button', { name: 'Yes, verify Jonas' }).click()
  await noah.getByRole('button', { name: 'Yes, confirm' }).click()
  await expect(noah.getByRole('heading', { name: 'Mutually verified' })).toBeVisible({ timeout: 20_000 })
  await expect(jonas.getByRole('heading', { name: 'Mutually verified' })).toBeVisible({ timeout: 20_000 })

  // a message each way, delivered (the acknowledgement came back over the mediator)
  await jonas.getByRole('button', { name: 'Open chat' }).click()
  await composer(jonas, 'Noah').fill('Over the mediator.')
  await jonas.getByRole('button', { name: 'Send' }).click()
  await expect(jonas.getByText(/Delivered/).last()).toBeVisible({ timeout: 20_000 })
  await noah.getByRole('button', { name: 'Open chat' }).click()
  await expect(noah.getByText('Over the mediator.', { exact: true }).last()).toBeVisible()
  await composer(noah, 'Jonas').fill('And back.')
  await noah.getByRole('button', { name: 'Send' }).click()
  await expect(noah.getByText(/Delivered/).last()).toBeVisible({ timeout: 20_000 })
  await expect(jonas.getByText('And back.', { exact: true }).last()).toBeVisible()

  // the contact's details say how it is carried; the list line says the carrier is connected
  await jonas.getByRole('button', { name: /^Noah Lindqvist.*, Details$/ }).click()
  await expect(jonas.getByText('Through the mediator', { exact: true })).toBeVisible()
  await jonas.getByRole('button', { name: 'Back' }).click()

  // Noah blocks Jonas: what Jonas writes next is taken by Noah's phone and shown nowhere
  await noah.getByRole('button', { name: /^Jonas Weber.*, Details$/ }).click()
  await noah.getByRole('button', { name: 'Block', exact: true }).click()
  await noah.getByRole('dialog').getByRole('button', { name: 'Block', exact: true }).click()
  await expect(noah.getByRole('dialog')).toBeHidden()
  await composer(jonas, 'Noah').fill('After the block.')
  await jonas.getByRole('button', { name: 'Send' }).click()
  await expect(jonas.getByText(/Delivered/).last()).toBeVisible({ timeout: 20_000 })
  await noah.getByRole('button', { name: 'Back' }).click()
  await expect(noah.getByText('After the block.')).toHaveCount(0)
  await jonas.getByRole('button', { name: 'Back' }).click()
  await expect(jonas.getByText('Online · Mediator connected', { exact: true })).toBeVisible()
})
