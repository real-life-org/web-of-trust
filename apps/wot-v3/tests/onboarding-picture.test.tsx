// The onboarding's picture (review 519, issue 520): a conversion still running when the profile step
// is left must not reach the flow; only the visit that chose a picture may set it.
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../src/i18n'
import { ProfileStep } from '../src/screens/identity/OnboardingScreen'
import type { SetupEvent, SetupState } from '../src/hooks'

afterEach(() => cleanup())

function deferred() {
  let resolve!: (v: string) => void
  const promise = new Promise<string>((r) => (resolve = r))
  return { promise, resolve }
}

const state = { name: 'profile', run: 1, words: null, positions: [0, 1, 2], displayName: 'Jonas Weber', image: null, termsVersion: 't' } as unknown as Extract<SetupState, { name: 'profile' }>

function pick(container: HTMLElement, name: string) {
  const input = container.querySelector('input[type=file]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File(['x'], name, { type: 'image/png' })] } })
}

describe('onboarding picture', () => {
  it('a conversion that finishes after the step was left does not overwrite the newer choice', async () => {
    const send = vi.fn<(e: SetupEvent) => void>()
    const old = deferred()
    const first = render(<LanguageProvider lang="en"><ProfileStep state={state} send={send} title="t" progress={null} onBack={() => {}} toAvatar={() => old.promise} /></LanguageProvider>)
    pick(first.container, 'a.png')
    first.unmount() // back to the words
    const second = render(<LanguageProvider lang="en"><ProfileStep state={state} send={send} title="t" progress={null} onBack={() => {}} toAvatar={async () => 'data:NEW'} /></LanguageProvider>)
    await act(async () => pick(second.container, 'b.png'))
    expect(send).toHaveBeenLastCalledWith({ type: 'image', value: 'data:NEW' })
    await act(async () => old.resolve('data:OLD'))
    expect(send).not.toHaveBeenCalledWith({ type: 'image', value: 'data:OLD' })
  })
})
