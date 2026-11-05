// App Store screenshots of Web of Trust (store-assets/appstore/README.md): the workbench page (the real
// app on the real library, the VTI mediator double, offline), five people who met and trusted each
// other, so the graph and the shared contacts show a real network. German, light. One phone is shot
// in its own frame of 440×956 CSS pixels; with device scale factor 3 every PNG is 1320×2868 (iPhone
// 6.9"). Runs only with WOT_APPSTORE_DIR (the output folder).
import { expect, test, type FrameLocator, type Page } from '@playwright/test'

test.skip(!process.env.WOT_APPSTORE_DIR, 'App Store screenshots only with WOT_APPSTORE_DIR')

const OUT = process.env.WOT_APPSTORE_DIR ?? ''
const FRAME = { width: 440, height: 956 }
const PEOPLE = 'jonas,noah,lea,mara,sam'
const MET = 'jonas-noah,jonas-lea,jonas-mara,jonas-sam,noah-lea,lea-mara,mara-sam,noah-sam'

type Device = {
  port: {
    stores: { contacts: { get(): { status: string; value?: { id: string; name: string | null }[] } } }
    trust: { giveTrust(id: string): { done: Promise<unknown> } }
  }
}
type World = { devices: Map<string, Device>; advance(ms: number): void }

/** everyone trusts everyone they met, except Jonas, who has not trusted Sam yet (the trust question
 *  is a screenshot); then the clock runs until the stars have gone out */
async function trustAll(page: Page) {
  await page.evaluate(async () => {
    const w = (await (window as unknown as { __wotWorkbench: Promise<World> }).__wotWorkbench) as World
    for (const [id, d] of w.devices) {
      for (const c of d.port.stores.contacts.get().value ?? []) {
        if (id === 'jonas' && c.name === 'Sam Okafor') continue
        await d.port.trust.giveTrust(c.id).done
      }
    }
  })
  for (let i = 0; i < 6; i++) {
    await page.evaluate(async () => ((await (window as unknown as { __wotWorkbench: Promise<World> }).__wotWorkbench) as World).advance(60_000))
    await page.waitForTimeout(1500)
  }
}

/** a phone of its own, the store size, over the workbench: the same device, a second view of it */
async function phone(page: Page, id: string): Promise<FrameLocator> {
  await page.evaluate(
    ({ id, w, h }) => {
      document.querySelector('iframe[name=shot]')?.remove()
      const f = document.createElement('iframe')
      const q = new URLSearchParams(location.search)
      q.set('phone', id)
      f.src = `?${q.toString()}`
      f.name = 'shot'
      f.setAttribute('style', `position:fixed;left:0;top:0;width:${w}px;height:${h}px;border:0;z-index:2147483647;background:#fff`)
      document.body.appendChild(f)
    },
    { id, w: FRAME.width, h: FRAME.height },
  )
  const f = page.frameLocator('iframe[name=shot]')
  await expect(f.getByRole('heading', { name: 'Kontakte' })).toBeVisible({ timeout: 30_000 })
  return f
}

async function shot(page: Page, file: string) {
  await page.frameLocator('iframe[name=shot]').locator('body').evaluate(() => document.fonts.ready.then(() => undefined))
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${OUT}/${file}`, clip: { x: 0, y: 0, ...FRAME }, animations: 'disabled', caret: 'hide' })
}

test('App Store screenshots: code, contacts, shared contacts, conversation, graph, trust', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 })
  const q = new URLSearchParams({ scenario: 'workbench', theme: 'light', lang: 'de', tz: 'Europe/Berlin', people: PEOPLE, met: MET })
  await page.goto(`/?${q.toString()}`)
  await expect(page.getByRole('heading', { name: /Workbench/ })).toBeVisible({ timeout: 90_000 })
  await trustAll(page)

  // 01: Noah shows his code
  const noah = await phone(page, 'noah')
  await noah.getByRole('button', { name: 'Persönlich verifizieren' }).click()
  await expect(noah.getByRole('button', { name: 'Code scannen' })).toBeVisible()
  await shot(page, '01-begegnung-code.png')

  // 04: a short conversation Jonas ↔ Noah, each message from its own phone
  const lines: Array<['jonas' | 'noah', string]> = [
    ['jonas', 'Schön, dass wir uns heute auf dem Markt getroffen haben!'],
    ['noah', 'Fand ich auch. Lea kennst du ja schon, oder?'],
    ['jonas', 'Ja, seit dem Sommerfest. Donnerstag Kaffee zu dritt?'],
    ['noah', 'Gern, ich frag sie!'],
  ]
  for (const [who, text] of lines) {
    const f = await phone(page, who)
    await f.getByRole('button', { name: who === 'jonas' ? /^Noah Lindqvist/ : /^Jonas Weber/ }).first().click()
    await f.getByRole('textbox', { name: who === 'jonas' ? 'Nachricht an Noah' : 'Nachricht an Jonas' }).fill(text)
    await f.getByRole('button', { name: 'Senden' }).click()
    await expect(f.getByText(/Angekommen/).last()).toBeVisible({ timeout: 60_000 })
  }
  let jonas = await phone(page, 'jonas')
  await jonas.getByRole('button', { name: /^Noah Lindqvist/ }).first().click()
  await expect(jonas.getByText('Gern, ich frag sie!').last()).toBeVisible({ timeout: 30_000 })
  await shot(page, '04-gespraech.png')

  // 02: Jonas's contacts
  jonas = await phone(page, 'jonas')
  await shot(page, '02-kontakte.png')

  // 03: Lea's details: shared contacts, trust given and received
  await jonas.getByRole('button', { name: /^Lea Brandt/ }).first().click()
  await jonas.getByRole('button', { name: /^Lea Brandt.*, Details$/ }).click()
  await expect(jonas.getByText('Gemeinsame Kontakte')).toBeVisible({ timeout: 30_000 })
  await shot(page, '03-gemeinsame-kontakte.png')

  // 05: the graph
  jonas = await phone(page, 'jonas')
  await jonas.getByRole('button', { name: /Graph/ }).last().click()
  await expect(jonas.getByRole('heading', { name: 'Graph' })).toBeVisible()
  await page.waitForTimeout(3000)
  await shot(page, '05-graph.png')

  // 06: the trust question for Sam, with what it discloses
  jonas = await phone(page, 'jonas')
  await jonas.getByRole('button', { name: /^Sam Okafor/ }).first().click()
  await jonas.getByRole('button', { name: /^Sam Okafor.*, Details$/ }).click()
  await jonas.getByRole('switch', { name: /Sam Okafor/ }).click()
  await expect(jonas.getByRole('dialog')).toBeVisible()
  await shot(page, '06-vertrauen.png')
})
