// The own name from the profile tab (Trust 6b): a page with one field, prefilled; Save draws the next
// profile revision through the port and returns; a failure stays on the page; an unchanged or empty
// name cannot be saved.
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createNavStore } from '../src/app/nav'
import { AppContextProvider } from '../src/hooks'
import { LanguageProvider } from '../src/i18n'
import { composeScenario } from '../harness/boot'
import { iiw } from '../harness/scenarios'
import { ProfileNameScreen } from '../src/screens/identity/ProfileNameScreen'
import type { AppPort, Result } from '../src/port'

const done = (r: Result) => ({ actId: 'x' as never, done: Promise.resolve(r) })

const PNG = 'data:image/webp;base64,UklGRiYAAABXRUJQVlA4TBoAAAAvAAAAAAfQ//73v/+BiOh/AAA='

function page(lang: 'en' | 'de', setProfile: AppPort['trust']['setProfile'], onBack = vi.fn(), toAvatar: (f: Blob) => Promise<string> = async () => PNG) {
  const comp = composeScenario(iiw)
  const port: AppPort = { ...comp.port, trust: { ...comp.port.trust, setProfile } }
  render(
    <LanguageProvider lang={lang}>
      <AppContextProvider value={{ port, platform: comp.platform, nav: createNavStore() }}>
        <ProfileNameScreen onBack={onBack} toAvatar={toAvatar} />
      </AppContextProvider>
    </LanguageProvider>,
  )
  return { onBack }
}

describe('the own name', () => {
  it('prefilled with the profile name; Save is off until the name changes; saving sets the profile and goes back', async () => {
    const setProfile = vi.fn(() => done({ ok: true, value: undefined }))
    const { onBack } = page('en', setProfile)
    const field = await screen.findByLabelText('Name')
    expect(field).toHaveValue('Jonas Weber')
    expect(field).toHaveAccessibleDescription('Contacts you trust see this name. Everyone else keeps the name from the card they scanned.')
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    fireEvent.change(field, { target: { value: '  Jonas W.  ' } })
    expect(save).toBeEnabled()
    fireEvent.click(save)
    await waitFor(() => expect(setProfile).toHaveBeenCalledWith({ name: 'Jonas W.' }))
    await waitFor(() => expect(onBack).toHaveBeenCalled())
  })

  it('an empty name cannot be saved; Enter saves like the button', async () => {
    const setProfile = vi.fn(() => done({ ok: true, value: undefined }))
    page('de', setProfile)
    const field = await screen.findByLabelText('Name')
    fireEvent.change(field, { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: 'Speichern' })).toBeDisabled()
    fireEvent.change(field, { target: { value: 'Jonas' } })
    fireEvent.submit(field.closest('form') as HTMLFormElement)
    await waitFor(() => expect(setProfile).toHaveBeenCalledWith({ name: 'Jonas' }))
  })

  it('a failed save says so and stays on the page', async () => {
    const setProfile = vi.fn(() => done({ ok: false, error: { kind: 'infra', code: 'storage', retryable: true } }))
    const { onBack } = page('en', setProfile)
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Jonas W.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Saving did not go through. Please try again.')).toBeInTheDocument()
    expect(onBack).not.toHaveBeenCalled()
  })

  it('a picture: chosen from a file, cropped by lib/avatar, saved with the name; the name alone keeps it; remove sends none', async () => {
    const setProfile = vi.fn(() => done({ ok: true, value: undefined }))
    page('en', setProfile)
    const input = await screen.findByLabelText('Choose picture')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.change(input, { target: { files: [new File([new Uint8Array([1, 2, 3])], 'me.png', { type: 'image/png' })] } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled())
    expect(screen.getByRole('button', { name: 'Change picture' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(setProfile).toHaveBeenCalledWith({ name: 'Jonas Weber', image: PNG }))
  })

  it('a file that is no picture says so and changes nothing', async () => {
    const setProfile = vi.fn(() => done({ ok: true, value: undefined }))
    page('en', setProfile, vi.fn(), async () => {
      throw new Error('decode')
    })
    fireEvent.change(await screen.findByLabelText('Choose picture'), { target: { files: [new File(['x'], 'x.txt', { type: 'text/plain' })] } })
    expect(await screen.findByText('This file could not be read as a picture.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('remove picture: Save sends the name without an image', async () => {
    const setProfile = vi.fn(() => done({ ok: true, value: undefined }))
    page('en', setProfile)
    fireEvent.change(await screen.findByLabelText('Choose picture'), { target: { files: [new File([new Uint8Array([1])], 'me.png', { type: 'image/png' })] } })
    await screen.findByRole('button', { name: 'Remove picture' })
    fireEvent.click(screen.getByRole('button', { name: 'Remove picture' }))
    // back to the profile's state (no picture): nothing to save
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Jonas W.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(setProfile).toHaveBeenCalledWith({ name: 'Jonas W.' }))
  })
})
