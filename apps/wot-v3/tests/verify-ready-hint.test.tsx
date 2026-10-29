// The ready screen's hint (E10): each code is for one person (VTI Open Issue 8), with or without a
// carrier; it names no network, so a build without a mediator says nothing false (review 1 of #449).
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
  it('with a carrier: each code is for one person', async () => {
    renderReady('connected')
    expect(await screen.findByText('Each code is for one person.')).toBeInTheDocument()
  })

  it('without a carrier: the same sentence, no word of the network', async () => {
    renderReady('not-configured')
    expect(await screen.findByText('Each code is for one person.')).toBeInTheDocument()
    expect(screen.queryByText(/network/)).toBeNull()
  })
})
