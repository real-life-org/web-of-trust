// The ready screen's hint names the network only where a carrier is configured: in a build without a
// mediator (the web build may run without one) nothing comes over the network (review 1 of #449).
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { VERIFY_CATALOG } from '../harness/catalog-verify'
import { composeScenario } from '../harness/boot'
import { iiw } from '../harness/scenarios'
import { App } from '../src/app/App'
import { writableStore, type Connectivity } from '../src/port'

const ready = VERIFY_CATALOG.find((e) => e.id === 'verify-ready')!

function renderReady(carrier: Connectivity['carrier']) {
  const base = composeScenario(iiw)
  const connectivity = writableStore<Connectivity>({ ...base.port.stores.connectivity.get(), carrier })
  const port = { ...base.port, stores: { ...base.port.stores, connectivity } }
  render(<App composition={{ ...base, port, flowOverride: ready.override }} />)
}

describe('verify ready hint', () => {
  it('with a carrier: one side shows, the other scans, the confirmation comes over the network', async () => {
    renderReady('connected')
    expect(await screen.findByText('Verification takes two. One side shows, the other scans; the confirmation comes over the network.')).toBeInTheDocument()
  })

  it('without a carrier: no word of the network', async () => {
    renderReady('not-configured')
    expect(await screen.findByText('Verification takes two. One side shows, the other scans.')).toBeInTheDocument()
    expect(screen.queryByText(/network/)).toBeNull()
  })
})
