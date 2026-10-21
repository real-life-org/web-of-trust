// Native implementations (architecture §5 table) against mocked plugins: what each port promises does
// not depend on the device. Whether the plugins behave like their mocks on a device is checked at the
// cutover (PR text "nativ ungeprüft").
import { beforeEach, describe, expect, it, vi } from 'vitest'

const plugins = vi.hoisted(() => ({
  app: { listeners: new Map<string, (e: unknown) => void>(), exits: 0, launch: null as string | null },
  share: { canShare: true, fail: null as string | null, calls: [] as unknown[] },
  fs: { files: new Map<string, string>(), rmdirs: 0 },
  mail: { hasAccount: true, opened: [] as unknown[] },
  scan: { result: null as null | { ScanResult: string } | Error, pending: null as null | Promise<{ ScanResult: string }> },
}))

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: async (name: string, cb: (e: unknown) => void) => {
      plugins.app.listeners.set(name, cb)
      return { remove: async () => void plugins.app.listeners.delete(name) }
    },
    exitApp: async () => void plugins.app.exits++,
    getLaunchUrl: async () => (plugins.app.launch ? { url: plugins.app.launch } : undefined),
  },
}))
vi.mock('@capacitor/share', () => ({
  Share: {
    canShare: async () => ({ value: plugins.share.canShare }),
    share: async (o: unknown) => {
      plugins.share.calls.push(o)
      if (plugins.share.fail) throw new Error(plugins.share.fail)
    },
  },
}))
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: {
    writeFile: async ({ path, data }: { path: string; data: string }) => {
      plugins.fs.files.set(path, data)
      return { uri: `file:///cache/${path}` }
    },
    rmdir: async ({ path }: { path: string }) => {
      plugins.fs.rmdirs++
      for (const k of [...plugins.fs.files.keys()]) if (k.startsWith(`${path}/`)) plugins.fs.files.delete(k)
    },
    readdir: async ({ path }: { path: string }) => ({
      files: [...plugins.fs.files.keys()].filter((k) => k.startsWith(`${path}/`)).map((k) => ({ name: k.slice(path.length + 1) })),
    }),
  },
}))
vi.mock('capacitor-email-composer', () => ({
  EmailComposer: {
    hasAccount: async () => ({ hasAccount: plugins.mail.hasAccount }),
    open: async (o: unknown) => void plugins.mail.opened.push(o),
  },
}))
vi.mock('@real-life-org/capacitor-zxing-scanner', () => ({
  CapacitorBarcodeScanner: {
    scanBarcode: async () => {
      if (plugins.scan.pending) return plugins.scan.pending
      const r = plugins.scan.result
      if (r instanceof Error) throw r
      return r ?? { ScanResult: '' }
    },
  },
  CapacitorBarcodeScannerTypeHint: { QR_CODE: 0 },
  CapacitorBarcodeScannerCameraDirection: { BACK: 1 },
  CapacitorBarcodeScannerAndroidScanningLibrary: { ZXING: 'zxing' },
}))

import { capacitorDeepLinks, capacitorLifecycle } from '../../src/platform/capacitor/lifecycle'
import { capacitorMail, capacitorShare, sharedSurvivors } from '../../src/platform/capacitor/share'
import { capacitorScanner, nativeScanFailure } from '../../src/platform/capacitor/scanner'
import { capacitorNotifications, type LocalNotificationsApi } from '../../src/platform/capacitor/notifications'
import { fakePrefs } from '../../src/platform/fake'

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  plugins.app.listeners.clear()
  plugins.app.exits = 0
  plugins.share.calls = []
  plugins.share.fail = null
  plugins.share.canShare = true
  plugins.fs.files.clear()
  plugins.mail.opened = []
  plugins.mail.hasAccount = true
  plugins.scan.result = null
  plugins.scan.pending = null
})

describe('LifecyclePort native (@capacitor/app)', () => {
  it('the hardware back goes to the handlers; nobody took it: the app exits', async () => {
    const l = capacitorLifecycle()
    await flush()
    const back = plugins.app.listeners.get('backButton')!
    const off = l.onBack(() => true)
    back({ canGoBack: false })
    expect(plugins.app.exits).toBe(0)
    off()
    back({ canGoBack: false })
    expect(plugins.app.exits).toBe(1)
  })

  it('app state maps to active and background; the listener goes with its cancel', async () => {
    const seen: string[] = []
    const off = capacitorLifecycle().onState((s) => seen.push(s))
    await flush()
    plugins.app.listeners.get('appStateChange')!({ isActive: false })
    plugins.app.listeners.get('appStateChange')!({ isActive: true })
    expect(seen).toEqual(['background', 'active'])
    off()
    await flush()
    expect(plugins.app.listeners.has('appStateChange')).toBe(false)
  })

  it('deep links: only card links, the launch URL once', async () => {
    plugins.app.launch = 'https://web-of-trust.de/c#abc'
    const d = capacitorDeepLinks()
    expect(await d.initial()).toBe('https://web-of-trust.de/c#abc')
    expect(await d.initial()).toBeNull()
    const got: string[] = []
    d.subscribe((u) => got.push(u))
    await flush()
    plugins.app.listeners.get('appUrlOpen')!({ url: 'https://evil.example/x' })
    plugins.app.listeners.get('appUrlOpen')!({ url: 'https://web-of-trust.de/c#def' })
    expect(got).toEqual(['https://web-of-trust.de/c#def'])
  })
})

describe('SharePort and MailPort native', () => {
  it('a shared file exists only for the hand-over', async () => {
    expect(await capacitorShare.shareFile({ name: 'report 1.txt', text: 'the report', title: 'Report', body: 'see file' })).toBe('shared')
    expect(plugins.share.calls).toEqual([{ title: 'Report', text: 'see file', files: ['file:///cache/wot-share/report_1.txt'], dialogTitle: 'Report' }])
    expect(plugins.fs.files.size).toBe(0)
    expect(await sharedSurvivors()).toEqual([])
  })

  it('a dismissed sheet is cancelled, a broken one unsupported; the file is gone either way', async () => {
    plugins.share.fail = 'Share canceled'
    expect(await capacitorShare.shareFile({ name: 'r.txt', text: 't', title: 'T' })).toBe('cancelled')
    plugins.share.fail = 'No activity found'
    expect(await capacitorShare.shareFile({ name: 'r.txt', text: 't', title: 'T' })).toBe('unsupported')
    expect(await capacitorShare.share({ text: 'x' })).toBe('unsupported')
    expect(plugins.fs.files.size).toBe(0)
    plugins.share.canShare = false
    expect(await capacitorShare.share({ text: 'x' })).toBe('unsupported')
  })

  it('mail: a draft in the mail app, unavailable without an account', async () => {
    expect(await capacitorMail.compose({ to: 'a@b.c', subject: 's', body: 'b' })).toBe('opened')
    expect(plugins.mail.opened).toEqual([{ to: ['a@b.c'], subject: 's', body: 'b', isHtml: false }])
    plugins.mail.hasAccount = false
    expect(await capacitorMail.compose({ to: 'a@b.c', subject: 's', body: 'b' })).toBe('unavailable')
  })
})

describe('ScannerPort native (ZXing plugin)', () => {
  it('maps the plugin errors; remembers the permission from the last scan', async () => {
    const prefs = fakePrefs()
    const s = capacitorScanner(prefs)
    expect(await s.permission()).toBe('prompt')
    plugins.scan.result = { ScanResult: 'code' }
    expect(await s.scan({ target: null, signal: new AbortController().signal })).toEqual({ kind: 'ok', text: 'code' })
    expect(await s.permission()).toBe('granted')
    plugins.scan.result = new Error('Camera permission not granted')
    expect(await s.scan({ target: null, signal: new AbortController().signal })).toEqual({ kind: 'permission-denied' })
    expect(await s.permission()).toBe('denied')
    expect(nativeScanFailure(new Error('User cancelled'))).toEqual({ kind: 'cancelled' })
    expect(nativeScanFailure(new Error('No camera available'))).toEqual({ kind: 'error', message: 'camera-unavailable' })
    expect(nativeScanFailure('weird')).toEqual({ kind: 'error', message: 'camera-failed' })
    plugins.scan.result = { ScanResult: '' }
    expect(await s.scan({ target: null, signal: new AbortController().signal })).toEqual({ kind: 'cancelled' })
  })

  it('an abort resolves cancelled at once; a late result of the native screen is dropped', async () => {
    let finish!: (r: { ScanResult: string }) => void
    plugins.scan.pending = new Promise((r) => (finish = r))
    const ctl = new AbortController()
    const p = capacitorScanner(fakePrefs()).scan({ target: null, signal: ctl.signal })
    ctl.abort()
    expect(await p).toEqual({ kind: 'cancelled' })
    finish({ ScanResult: 'late' })
  })
})

describe('NotificationPort native (N12)', () => {
  function api() {
    let pending: { id: number; extra?: unknown }[] = []
    let delivered: { id: number; extra?: unknown; title: string; body: string }[] = []
    const a = {
      fail: false,
      deliverAll() {
        delivered.push(...pending.map((p) => ({ ...p, title: '', body: '' })))
        pending = []
      },
      /** the platform drops `extra` of delivered notifications (seen on some Android versions) */
      dropExtras() {
        delivered = delivered.map((d) => ({ id: d.id, title: d.title, body: d.body }))
      },
      checkPermissions: async () => ({ display: 'granted' }),
      requestPermissions: async () => ({ display: 'granted' }),
      schedule: async ({ notifications }: { notifications: { id: number; extra?: unknown }[] }) => {
        pending.push(...notifications)
        return { notifications: notifications.map((n) => ({ id: n.id })) }
      },
      getPending: async () => {
        if (a.fail) throw new Error('plugin gone')
        return { notifications: pending }
      },
      getDeliveredNotifications: async () => ({ notifications: delivered }),
      cancel: async ({ notifications }: { notifications: { id: number }[] }) => {
        const ids = new Set(notifications.map((n) => n.id))
        pending = pending.filter((p) => !ids.has(p.id))
      },
      removeDeliveredNotifications: async ({ notifications }: { notifications: { id: number }[] }) => {
        const ids = new Set(notifications.map((n) => n.id))
        delivered = delivered.filter((d) => !ids.has(d.id))
      },
      addListener: async () => ({ remove: async () => undefined }),
    }
    return a
  }

  it('cleans per namespace, also when delivered ones lost their extra; verifies over list()', async () => {
    const prefs = fakePrefs()
    const a = api()
    const n = capacitorNotifications(prefs, a as unknown as LocalNotificationsApi)
    await n.notify({ ns: 'one', id: 'm1', title: 'New message', body: '', route: 'c:x' })
    await n.notify({ ns: 'one', id: 'm2', title: 'New message', body: '', route: 'c:x' })
    await n.notify({ ns: 'two', id: 'm1', title: 'New message', body: '', route: 'c:y' })
    // the ID table lives under the namespace's own prefix: wipeNamespace removes it with the rest
    expect(prefs.keys('one:')).toEqual(['one:notify.ids'])
    a.deliverAll()
    a.dropExtras()
    await n.notify({ ns: 'one', id: 'm3', title: 'New message', body: '', route: 'c:x' })
    expect((await n.list()).map((e) => [e.ns, e.state])).toEqual([
      ['one', 'scheduled'],
      ['one', 'delivered'],
      ['one', 'delivered'],
      ['two', 'delivered'],
    ])
    expect(await n.cancelNamespace('one')).toEqual({ ok: true, remaining: [] })
    expect(await n.removeDelivered('one')).toEqual({ ok: true, remaining: [] })
    expect(await n.verifyNone('one')).toBe(true)
    expect(await n.verifyNone('two')).toBe(false)
    expect(prefs.keys('one:')).toEqual([])
    expect(await n.removeDelivered('all')).toEqual({ ok: true, remaining: [] })
    expect(await n.verifyNone('all')).toBe(true)
  })

  it('a failing plugin is reported, never thrown', async () => {
    const a = api()
    a.fail = true
    const n = capacitorNotifications(fakePrefs(), a as unknown as LocalNotificationsApi)
    expect(await n.cancelNamespace('one')).toEqual({ ok: false, remaining: [] })
    expect(await n.verifyNone('one')).toBe(false)
  })
})
