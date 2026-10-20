// Every state of the report machine has a screen catalog entry (architecture §7.2), and every entry renders.
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { REPORT_CATALOG, REPORT_CATALOG_STATES, REPORT_SAMPLE_MESSAGES, REPORT_SAMPLE_NAME, reportStates } from '../harness/catalog-report'
import { composeScenario } from '../harness/boot'
import { iiw } from '../harness/scenarios'
import { App } from '../src/app/App'

describe('report screen catalog', () => {
  it('has an entry for every state but exit', () => {
    expect(reportStates.filter((s) => s !== 'exit' && !REPORT_CATALOG_STATES.includes(s))).toEqual([])
  })

  it.each(REPORT_CATALOG.map((e) => [e.id, e] as const))('%s renders', async (_id, entry) => {
    window.__wotReportSample = { name: REPORT_SAMPLE_NAME, messages: REPORT_SAMPLE_MESSAGES }
    render(<App composition={{ ...composeScenario(iiw), flowOverride: entry.override }} />)
    expect(await screen.findByText('Report and block')).toBeInTheDocument()
  })
})
