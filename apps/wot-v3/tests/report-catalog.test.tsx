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
    // a contact blocked before is reported, not blocked again: the title says so
    expect(await screen.findByText(entry.override.flow === 'report' && entry.override.blocked ? 'Report' : 'Report and block')).toBeInTheDocument()
  })

  it('the info page tells that the mediator holds messages encrypted until collected, not that they lie only on the devices (#459)', async () => {
    window.__wotReportSample = { name: REPORT_SAMPLE_NAME, messages: REPORT_SAMPLE_MESSAGES }
    const entry = REPORT_CATALOG.find((e) => e.id === 'report-info')!
    render(<App composition={{ ...composeScenario(iiw), flowOverride: entry.override }} />)
    expect(await screen.findByText(`Web of Trust has no accounts. Messages are end-to-end encrypted. A mediator holds them encrypted until ${REPORT_SAMPLE_NAME} collects them, and cannot read them.`)).toBeInTheDocument()
    expect(screen.queryByText(/only on your device/)).toBeNull()
  })

  it('a blocked contact: the choice notes the hidden messages, the review asks only for the mail (Anton 21.10.)', async () => {
    window.__wotReportSample = { name: REPORT_SAMPLE_NAME, messages: REPORT_SAMPLE_MESSAGES }
    const entry = REPORT_CATALOG.find((e) => e.id === 'report-selecting-blocked')!
    render(<App composition={{ ...composeScenario(iiw), flowOverride: entry.override }} />)
    expect(await screen.findByText(/This list also shows the messages hidden in the conversation/)).toBeInTheDocument()
  })

  it('after the share sheet speaks of the chosen app, not of a mail draft (review 422 CodeRabbit)', async () => {
    window.__wotReportSample = { name: REPORT_SAMPLE_NAME, messages: REPORT_SAMPLE_MESSAGES }
    const entry = REPORT_CATALOG.find((e) => e.id === 'report-handedOver-shared')!
    render(<App composition={{ ...composeScenario(iiw), flowOverride: entry.override }} />)
    expect(await screen.findByText('The report is ready in the app you chose')).toBeInTheDocument()
    expect(screen.getByText('Share the report again')).toBeInTheDocument()
    expect(screen.queryByText('Open the mail again')).toBeNull()
  })

  it.each(['report-blocking', 'report-composing'])('%s offers no back button while the block or mail composition runs (review 422 CodeRabbit)', async (id) => {
    window.__wotReportSample = { name: REPORT_SAMPLE_NAME, messages: REPORT_SAMPLE_MESSAGES }
    const entry = REPORT_CATALOG.find((e) => e.id === id)!
    render(<App composition={{ ...composeScenario(iiw), flowOverride: entry.override }} />)
    expect(await screen.findByText('Report and block')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
  })

  it.each(['report-blockFailed', 'report-handedOver'])('%s offers the back button again once nothing runs (review 422 CodeRabbit)', async (id) => {
    window.__wotReportSample = { name: REPORT_SAMPLE_NAME, messages: REPORT_SAMPLE_MESSAGES }
    const entry = REPORT_CATALOG.find((e) => e.id === id)!
    render(<App composition={{ ...composeScenario(iiw), flowOverride: entry.override }} />)
    expect(await screen.findByText('Report and block')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument()
  })
})
