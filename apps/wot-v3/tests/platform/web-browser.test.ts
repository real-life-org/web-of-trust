// @vitest-environment node
// The web's BrowserPort (login into a web app, same-device return; review #553): a tab the browser
// blocks is not reported as opened, the opened tab gets no handle back, and only https or http
// addresses are opened.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { webBrowser } from '../../src/platform/web'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubWindow(result: { opener: unknown } | null) {
  const calls: unknown[][] = []
  vi.stubGlobal('window', {
    open: (...args: unknown[]) => {
      calls.push(args)
      return result
    },
  })
  return calls
}

describe('web BrowserPort', () => {
  it('a blocked tab is unavailable, never opened', async () => {
    stubWindow(null)
    expect(await webBrowser.open('https://beispiel.org/fertig?response_code=c')).toBe('unavailable')
  })

  it('an opened tab is opened and loses its handle back to the app', async () => {
    const tab = { opener: {} as unknown }
    const calls = stubWindow(tab)
    expect(await webBrowser.open('https://beispiel.org/fertig?response_code=c')).toBe('opened')
    expect(calls).toEqual([['https://beispiel.org/fertig?response_code=c', '_blank']])
    expect(tab.opener).toBeNull()
  })

  it('anything but an https or http address is not opened', async () => {
    const calls = stubWindow({ opener: null })
    expect(await webBrowser.open('javascript:alert(1)')).toBe('unavailable')
    expect(await webBrowser.open('openid://?x')).toBe('unavailable')
    expect(calls).toEqual([])
  })
})
