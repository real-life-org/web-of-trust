// Every state of the verify machine has a screen catalog entry (architecture §7.2), and every
// entry renders (light check of the view over the simulation; screenshots in e2e/verify.spec.ts).
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { VERIFY_CATALOG, VERIFY_CATALOG_STATES, VERIFY_STATES } from '../harness/catalog-verify'
import { composeScenario } from '../harness/boot'
import { iiw } from '../harness/scenarios'
import { App } from '../src/app/App'

describe('verify screen catalog', () => {
  it('has an entry for every state but exit', () => {
    expect(VERIFY_STATES.filter((s) => s !== 'exit' && !VERIFY_CATALOG_STATES.includes(s))).toEqual([])
  })

  it.each(VERIFY_CATALOG.map((e) => [e.id, e] as const))('%s renders', async (_id, entry) => {
    const composition = { ...composeScenario(iiw), flowOverride: entry.override }
    render(<App composition={composition} />)
    expect(await screen.findByText('Verify in person')).toBeInTheDocument()
  })
})
