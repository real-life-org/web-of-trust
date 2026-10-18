// The identity screens through the gate, clicked like a person would (Testing Library on the
// simulation and the fake device), plus the screen catalog coverage (architecture §7.2).
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { App } from '../src/app/App'
import { composeIdentityScenario, HARNESS_PASSPHRASE } from '../harness/boot'
import { CATALOG } from '../harness/catalog'
import { bioInvalidated, freshInstall, gen2Upgrade, locked, recoveryScenario } from '../harness/scenarios'
import { DELETE_TABLE } from '../src/flows/delete'
import { LEGACY_TABLE } from '../src/flows/legacy-reset'
import { PROTECTION_TABLE } from '../src/flows/protection'
import { ONBOARDING_TABLE, RECOVERY_TABLE } from '../src/flows/setup'
import { UNLOCK_TABLE } from '../src/flows/unlock'
import type { Row } from '../src/flows/machine'

afterEach(() => cleanup())

const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } })

describe('identity through the gate', () => {
  it('fresh install: create, words, check, name, password, done, then the app', async () => {
    const comp = await composeIdentityScenario(freshInstall)
    render(<App composition={comp} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Create identity' }))
    const list = await screen.findByRole('list', { name: 'Your 12 Magic Words' })
    const words = [...list.querySelectorAll('li')].map((li) => li.querySelector('.font-mono')?.textContent ?? '')
    expect(words).toHaveLength(12)
    const next = screen.getByRole('button', { name: 'Continue' })
    expect(next).toBeDisabled()
    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box)
    fireEvent.click(next)
    fireEvent.click(await screen.findByRole('button', { name: 'I have written them down' }))
    const inputs = await screen.findAllByLabelText(/^Word \d+$/)
    const labels = screen.getAllByText(/^Word \d+$/)
    labels.forEach((label, i) => type(inputs[i] as HTMLElement, words[Number(label.textContent?.split(' ')[1]) - 1] ?? ''))
    fireEvent.click(screen.getByRole('button', { name: 'Check' }))
    type(await screen.findByLabelText('Name'), 'Jonas Weber')
    fireEvent.click(screen.getByRole('checkbox', { name: /I accept the content rules/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(await screen.findByRole('button', { name: /With a password/ }))
    type(screen.getByLabelText('Password'), 'correct horse')
    type(screen.getByLabelText('Confirm password'), 'correct horse')
    fireEvent.click(screen.getByRole('button', { name: 'Protect identity' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }))
    expect(await screen.findByRole('heading', { name: 'Contacts' })).toBeInTheDocument()
    expect(comp.runtime.state.get()).toMatchObject({ status: 'unlocked' })
  })

  it('locked: wrong password stays with an error, the right one opens; "not now" for biometrics', async () => {
    const comp = await composeIdentityScenario(locked)
    render(<App composition={comp} />)
    const field = await screen.findByLabelText('Password')
    type(field, 'nope')
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    expect(await screen.findByText('Wrong password.')).toBeInTheDocument()
    type(screen.getByLabelText('Password'), HARNESS_PASSPHRASE)
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }))
    expect(await screen.findByRole('heading', { name: 'Contacts' })).toBeInTheDocument()
  })

  it('biometrics invalidated: hint, password, repair, offer', async () => {
    const comp = await composeIdentityScenario(bioInvalidated)
    render(<App composition={comp} />)
    expect(await screen.findByText(/Biometrics no longer open this identity/)).toBeInTheDocument()
    type(screen.getByLabelText('Password'), HARNESS_PASSPHRASE)
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    expect(await screen.findByRole('dialog', { name: 'Biometric unlock' })).toBeInTheDocument()
    expect(comp.runtime.state.get()).toMatchObject({ status: 'unlocked', protection: 'passphrase' })
  })

  it('Gen-2 upgrade: the notice once, then welcome', async () => {
    const comp = await composeIdentityScenario(gen2Upgrade)
    render(<App composition={comp} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Got it' }))
    expect(await screen.findByRole('button', { name: 'Create identity' })).toBeInTheDocument()
    expect(comp.device.legacy.databases.size).toBe(0)
  })

  it('recovery: words, consent, password, keys-only result', async () => {
    const comp = await composeIdentityScenario(recoveryScenario)
    render(<App composition={comp} />)
    const area = await screen.findByLabelText('Magic Words')
    type(area, 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon')
    expect(await screen.findByText(/These words do not fit together/)).toBeInTheDocument()
    type(area, '1. abandon\n2. abandon\n3. abandon\n4. abandon\n5. abandon\n6. abandon\n7. abandon\n8. abandon\n9. abandon\n10. abandon\n11. abandon\n12. about')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(await screen.findByRole('checkbox', { name: /I accept the content rules/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(await screen.findByRole('button', { name: /With a password/ }))
    type(screen.getByLabelText('Password'), 'restored pass')
    type(screen.getByLabelText('Confirm password'), 'restored pass')
    fireEvent.click(screen.getByRole('button', { name: 'Protect identity' }))
    expect(await screen.findByText('Your keys are back')).toBeInTheDocument()
    expect(screen.getByText(/Contacts and groups do not come along/)).toBeInTheDocument()
  })

  it('delete from the profile tab: explain, typed word, phases, done, welcome', async () => {
    const comp = await composeIdentityScenario({ ...locked, identity: { state: 'unlocked', protection: 'passphrase' } })
    render(<App composition={comp} />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Profile' }))[0] as HTMLElement)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete identity' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    const confirm = screen.getByRole('button', { name: 'Delete identity' })
    expect(confirm).toBeDisabled()
    type(screen.getByLabelText('Confirmation'), 'delete')
    fireEvent.click(confirm)
    expect(await screen.findByText('Deleted on this device')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(await screen.findByRole('button', { name: 'Create identity' })).toBeInTheDocument()
    await waitFor(() => expect(comp.device.vault.stores.vaults.size).toBe(0))
  })

  it('the screen protection follows the words and passphrase states', async () => {
    const comp = await composeIdentityScenario(freshInstall)
    render(<App composition={comp} />)
    const screenPort = comp.platform.screen as unknown as { current(): string }
    fireEvent.click(await screen.findByRole('button', { name: 'Create identity' }))
    await screen.findByRole('list', { name: 'Your 12 Magic Words' })
    expect(screenPort.current()).toBe('sensitive')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    })
    expect(screenPort.current()).toBe('normal')
  })
})

describe('screen catalog', () => {
  const states = (table: readonly Row[]) => new Set(table.map((r) => r.from).filter((f) => f !== 'any' && f !== 'deciding'))
  const covered = (flow: string) => new Set<string>(CATALOG.filter((e) => e.override.flow === flow).map((e) => ('state' in e.override ? e.override.state.name : '')))

  it.each([
    ['onboarding', ONBOARDING_TABLE],
    ['recovery', RECOVERY_TABLE],
    ['unlock', UNLOCK_TABLE],
    ['protection', PROTECTION_TABLE],
    ['delete', DELETE_TABLE],
    ['legacy', LEGACY_TABLE],
  ] as const)('every state of %s has a catalog entry', (flow, table) => {
    const have = covered(flow)
    // states that render the same screen as a neighbour are covered by it (documented here)
    const same: Record<string, string> = { quiescing: 'wiping', deregistering: 'wiping', sealing: 'wiping', closing: 'wiping', verifying: 'wiping', marking: 'wiping', resumeInit: 'resumeInit', resumeActivate: 'resumeActivate' }
    const missing = [...states(table)].filter((s) => !have.has(s) && !have.has(same[s] ?? ''))
    expect(missing).toEqual([])
  })
})
