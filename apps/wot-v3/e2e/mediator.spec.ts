// Acceptance "two phones" over the VTI mediator (TRANSPORT.md "The VTI mediator", "The displayed card's
// instance"): the real adapter, the real library, the real wire and the library's mediator adapter per
// relationship, over the mediator double in the page (real TSP and DIDComm crypto). The encounter is one
// scan: Noah shows, Jonas scans, Jonas's bundle reaches the instance of Noah's displayed card over the
// mediator, Noah confirms, and the confirmation returns over the mediator. Then a message each way and a
// block. The optical return path stays the way out without a network. Functional checks, no baselines.
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

test('two phones over the mediator: one scan, the confirmation over the network, a message each way, a block', async ({ page }) => {
  const { jonas, noah } = await pair(page)
  // configured, nothing carried yet
  await expect(jonas.getByText('Online · Mediator set up', { exact: true })).toBeVisible()

  // Noah shows, Jonas scans: Jonas's bundle goes over the mediator to the instance of Noah's card
  await noah.getByRole('button', { name: 'Verify in person' }).click()
  await expect(noah.getByRole('img', { name: 'Your verification code' })).toBeVisible()
  await jonas.getByRole('button', { name: 'Verify in person' }).click()
  await jonas.getByRole('button', { name: 'Scan code' }).click()
  await jonas.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(jonas.getByRole('heading', { name: 'Noah Lindqvist verified' })).toBeVisible()
  // no optical step: the bundle reaches Noah's shown card, the same screen asks for Jonas (E9)
  await expect(noah.getByRole('heading', { name: 'Is this the person in front of you?' })).toBeVisible({ timeout: 20_000 })
  await noah.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(noah.getByRole('heading', { name: /^You and \S+ are now connected\.$/ })).toBeVisible({ timeout: 20_000 })
  // Jonas waited on the same screen: the confirmation came back over the mediator
  await expect(jonas.getByRole('heading', { name: /^You and \S+ are now connected\.$/ })).toBeVisible({ timeout: 20_000 })
  await expect(jonas.getByText(/No answer yet/)).toHaveCount(0)
  await noah.getByRole('button', { name: 'Open chat' }).click()
  await expect(noah.getByText('Now mutually verified', { exact: true })).toBeVisible()

  // a message each way, delivered (the acknowledgement came back over the mediator)
  await jonas.getByRole('button', { name: 'Open chat' }).click()
  await composer(jonas, 'Noah').fill('Over the mediator.')
  await jonas.getByRole('button', { name: 'Send' }).click()
  await expect(jonas.getByText(/Delivered/).last()).toBeVisible({ timeout: 20_000 })
  // Noah is in the conversation where he confirmed
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
  // the delivery of this very message: one "Delivered" more than before it was sent
  const delivered = await jonas.getByText(/Delivered/).count()
  await composer(jonas, 'Noah').fill('After the block.')
  await jonas.getByRole('button', { name: 'Send' }).click()
  await expect(jonas.getByText(/Delivered/)).toHaveCount(delivered + 1, { timeout: 20_000 })
  await noah.getByRole('button', { name: 'Back' }).click()
  await expect(noah.getByText('After the block.')).toHaveCount(0)
  await jonas.getByRole('button', { name: 'Back' }).click()
  await expect(jonas.getByText('Online · Mediator connected', { exact: true })).toBeVisible()
})

test('two phones over the mediator: without a network the optical return path is the way out; mutual once Jonas is back online', async ({ page }) => {
  const { jonas, noah } = await pair(page)
  await page.getByLabel('Jonas Weber online').uncheck()
  await noah.getByRole('button', { name: 'Verify in person' }).click()
  await expect(noah.getByRole('img', { name: 'Your verification code' })).toBeVisible()
  await jonas.getByRole('button', { name: 'Verify in person' }).click()
  await jonas.getByRole('button', { name: 'Scan code' }).click()
  await jonas.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(jonas.getByRole('heading', { name: 'Noah Lindqvist verified' })).toBeVisible()
  // the same step optically: Jonas shows his sent card, Noah takes it over and confirms once
  await jonas.getByRole('button', { name: 'Show code' }).click()
  await expect(jonas.getByRole('heading', { name: 'Same encounter, optically' })).toBeVisible()
  await noah.getByRole('button', { name: 'Scan code' }).click()
  // one question, before Noah's confirmation is issued (A1: taking the sent card over asks nothing)
  await expect(noah.getByText('Jonas scanned your code', { exact: true })).toBeVisible()
  await expect(noah.getByRole('heading', { name: 'Is this the person in front of you?' })).toBeVisible()
  await noah.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(noah.getByRole('heading', { name: 'Your confirmation is out' })).toBeVisible()
  // the card's instance became the relationship's (bound by the optical record): Jonas's bundle and
  // Noah's confirmation cross the mediator once Jonas is online
  await page.getByLabel('Jonas Weber online').check()
  await expect(noah.getByRole('heading', { name: /^You and \S+ are now connected\.$/ })).toBeVisible({ timeout: 20_000 })
  await expect(jonas.getByRole('heading', { name: /^You and \S+ are now connected\.$/ })).toBeVisible({ timeout: 20_000 })
})
