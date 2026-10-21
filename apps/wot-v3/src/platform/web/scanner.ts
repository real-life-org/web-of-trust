// Web camera scanner (architecture §5 table: html5-qrcode in `target`; legacy VerificationFlow.tsx).
// The only place in src/ that may import html5-qrcode (.dependency-cruiser.cjs). The library is loaded
// on the first scan, so a page that never scans does not fetch it.
//
// Never throws: every failure maps to a ScannerPort result (permission-denied = camera-denied, error =
// camera-unavailable, with a code as message, never a raw exception text).

import type { ScannerPort } from '../ports'

type ScanResult = Awaited<ReturnType<ScannerPort['scan']>>

/** The part of html5-qrcode the port uses (a seam for tests). */
export interface QrEngine {
  start(onText: (text: string) => void): Promise<void>
  stop(): Promise<void>
}
export type QrEngineFactory = (elementId: string) => Promise<QrEngine>

const html5QrEngine: QrEngineFactory = async (elementId) => {
  const { Html5Qrcode } = await import('html5-qrcode')
  const scanner = new Html5Qrcode(elementId, { verbose: false })
  return {
    start: (onText) =>
      scanner
        .start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 200, height: 200 } },
          (text) => onText(text),
          () => {
            // no code in this frame: not an error
          },
        )
        .then(() => undefined),
    async stop() {
      if (scanner.isScanning) await scanner.stop()
      scanner.clear()
    },
  }
}

/** A camera failure as a port result: denied permission is its own class, everything else is "no camera". */
export function scanFailure(e: unknown): ScanResult {
  const name = e instanceof Error || e instanceof DOMException ? e.name : ''
  const text = (e instanceof Error ? e.message : typeof e === 'string' ? e : '').toLowerCase()
  if (name === 'NotAllowedError' || name === 'SecurityError' || /permission|denied|not allowed/.test(text)) return { kind: 'permission-denied' }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || /not found|no camera|requested device/.test(text)) return { kind: 'error', message: 'camera-unavailable' }
  if (name === 'NotReadableError' || /in use|could not start|not readable/.test(text)) return { kind: 'error', message: 'camera-busy' }
  return { kind: 'error', message: 'camera-failed' }
}

let seq = 0

export function webScanner(engine: QrEngineFactory = html5QrEngine): ScannerPort {
  return {
    async availability() {
      try {
        const md = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
        if (!md?.getUserMedia || !md.enumerateDevices) return 'unsupported'
        // device kinds are listed before any permission (labels are not)
        return (await md.enumerateDevices()).some((d) => d.kind === 'videoinput') ? 'available' : 'no-camera'
      } catch {
        return 'unsupported'
      }
    },
    async permission() {
      try {
        const st = await navigator.permissions?.query({ name: 'camera' as PermissionName })
        return st?.state === 'granted' ? 'granted' : st?.state === 'denied' ? 'denied' : 'prompt'
      } catch {
        // Firefox and older Safari know no camera permission query: the browser asks at the scan
        return 'prompt'
      }
    },
    async scan({ target, signal }) {
      if (signal.aborted) return { kind: 'cancelled' }
      if (!target) return { kind: 'error', message: 'scanner-no-target' }
      if (!target.id) target.id = `wot-scan-${++seq}`
      // an abort while the library loads ends the scan at once; an engine that arrives later is never started
      let onLoadAbort: () => void = () => undefined
      const aborted = new Promise<null>((resolve) => {
        onLoadAbort = () => resolve(null)
        signal.addEventListener('abort', onLoadAbort, { once: true })
      })
      let qr: QrEngine | null
      try {
        qr = await Promise.race([engine(target.id), aborted])
      } catch {
        return { kind: 'error', message: 'scanner-load-failed' }
      } finally {
        signal.removeEventListener('abort', onLoadAbort)
      }
      if (!qr || signal.aborted) return { kind: 'cancelled' }
      const engineOn = qr
      return await new Promise<ScanResult>((resolve) => {
        let done = false
        let running = false
        const release = () => {
          if (running) {
            running = false
            void engineOn.stop().catch(() => undefined)
          }
        }
        const finish = (r: ScanResult) => {
          if (done) return
          done = true
          signal.removeEventListener('abort', onAbort)
          release()
          resolve(r)
        }
        const onAbort = () => finish({ kind: 'cancelled' })
        signal.addEventListener('abort', onAbort)
        if (signal.aborted) return finish({ kind: 'cancelled' })
        engineOn.start((text) => finish({ kind: 'ok', text })).then(
          () => {
            running = true
            // aborted or decided while the camera was starting: it is released at once
            if (done) release()
          },
          (e: unknown) => finish(scanFailure(e)),
        )
      })
    },
    // a browser has no way into its own settings; the screen tells the person where to look
    openSettings: async () => undefined,
  }
}
