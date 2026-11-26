// The login page's preview and the answer come from one source (review #557): before the
// confirmation what the switch selects, after it what was confirmed and is sent, also on a retry.
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNavStore } from '../src/app/nav'
import { AppContextProvider } from '../src/hooks'
import { LanguageProvider } from '../src/i18n'
import { composeScenario } from '../harness/boot'
import { iiw } from '../harness/scenarios'
import { LoginView } from '../src/screens/login/LoginScreen'
import { loginTarget, readLoginRequest } from '../src/lib/login-request'
import type { LoginState } from '../src/hooks'

const raw = `openid://?${new URLSearchParams({ response_type: 'id_token', response_mode: 'direct_post', scope: 'openid', id_token_type: 'subject_signed', client_id: 'https://beispiel.org', response_uri: 'https://beispiel.org/antwort', nonce: 'n', state: 's' }).toString()}`
const target = loginTarget(readLoginRequest(raw)!)!
const PIC = 'data:image/png;base64,iVBORw0KGgo='
const own = { name: 'Anton', picture: PIC }

/** Radix draws the image once `Image` reports a load, which jsdom never does (see contact-list-image) */
class LoadingImage {
  complete = false
  naturalWidth = 0
  crossOrigin: string | null = null
  referrerPolicy = ''
  addEventListener() {}
  removeEventListener() {}
  set src(_v: string) {
    this.complete = true
    this.naturalWidth = 1
  }
}
beforeEach(() => vi.stubGlobal('Image', LoadingImage))
afterEach(() => vi.unstubAllGlobals())
const picture = () => document.querySelector(`img[src="${PIC}"]`)

function view(state: LoginState, send = vi.fn()) {
  const comp = composeScenario(iiw)
  render(
    <LanguageProvider lang="de">
      <AppContextProvider value={{ port: comp.port, platform: comp.platform, nav: createNavStore() }}>
        <LoginView state={state} send={send} own={own} />
      </AppContextProvider>
    </LanguageProvider>,
  )
  return send
}

describe('login preview', () => {
  it('switch on (default): preview shows the profile, and confirm sends exactly that', async () => {
    const send = view({ name: 'review', run: 0, raw, target })
    expect(screen.getByText('So sieht beispiel.org dich.')).toBeInTheDocument()
    await vi.waitFor(() => expect(picture()).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Anmelden' }))
    expect(send).toHaveBeenCalledWith({ type: 'confirm', shared: own })
  })

  it('switch off: no picture, the hint says only an identifier, and confirm sends nothing', () => {
    const send = view({ name: 'review', run: 0, raw, target })
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.queryByText('So sieht beispiel.org dich.')).toBeNull()
    expect(screen.getByText('beispiel.org sieht nur eine Kennung, die nur dort gilt.')).toBeInTheDocument()
    expect(picture()).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Anmelden' }))
    expect(send).toHaveBeenCalledWith({ type: 'confirm', shared: { name: null, picture: null } })
  })

  it('after a failure the preview shows what was confirmed, not the profile of now', () => {
    view({ name: 'failed', run: 1, raw, target, shared: { name: 'Anton', picture: null }, code: 'login-unreachable' })
    expect(screen.getByText('So sieht beispiel.org dich.')).toBeInTheDocument()
    expect(picture()).toBeNull()
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
  })
})
