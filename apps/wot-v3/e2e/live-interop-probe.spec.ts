// The interop probe of the developer area against a foreign Trust Task agent over a TSP 1.0 mediator
// (live, real network), in the harness page (`?probe=<mediator>`, the module of the web build with
// VITE_INTEROP_PROBE). The agent is the Rust double of trust-protocol-interop-double (trust-tasks-rs /
// trust-tasks-tsp 0.35.4, affinidi-tsp 0.3.0), started by the tester with `--serve` (EXPECT
// unsupportedType, the default) or `--serve --next-step` (EXPECT next-step). Runs only with
// RLTP_LIVE_MEDIATOR=1, MEDIATOR_DID and FOREIGN_DID (the double's DOUBLE_READY did:key).
import { expect, test } from '@playwright/test'

test.skip(process.env.RLTP_LIVE_MEDIATOR !== '1' || !process.env.FOREIGN_DID, 'live only with RLTP_LIVE_MEDIATOR=1 and FOREIGN_DID')

test('interop probe: a carried document to a foreign agent, its answer in the delivery line', async ({ page }) => {
  const mediator = process.env.MEDIATOR_DID
  const agent = process.env.FOREIGN_DID ?? ''
  if (!mediator) throw new Error('live: MEDIATOR_DID names the TSP 1.0 mediator (0.45 or later)')
  const expectAnswer = process.env.EXPECT === 'next-step' ? 'Arrived, open at the recipient' : 'Rejected by the recipient (unsupportedType)'
  const q = new URLSearchParams({ scenario: 'iiw', theme: 'light', lang: 'en', probe: mediator, ...(process.env.MEDIATOR_ALLOW_INSECURE === '1' ? { insecure: '1' } : {}) })
  await page.goto(`/?${q.toString()}`)
  await page.getByRole('button', { name: 'Profile' }).first().click()
  await page.getByRole('button', { name: 'Interop probe' }).click()
  await expect(page.getByRole('heading', { name: 'Interop probe' })).toBeVisible()
  // an identifier that is no did:key is refused before anything goes out
  await page.getByLabel('Identifier of the agent (did:key)').fill('did:web:example.org')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByTestId('interop-line')).toHaveText('Not a did:key of the form did:key:z6Mk…')
  await page.getByLabel('Identifier of the agent (did:key)').fill(agent)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByTestId('interop-line')).toHaveText(expectAnswer, { timeout: 45_000 })
  await expect(page.getByText(/Sent as: (routed|direct)/)).toBeVisible()
})
