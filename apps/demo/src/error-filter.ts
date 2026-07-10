/**
 * Guard for the global window error handlers in main.tsx.
 *
 * The app's last-resort `window.error` / `unhandledrejection` handlers replace the
 * whole page with a crash screen. On iOS, third-party browsers (Firefox, Chrome,
 * Brave — all WebKit) inject their own content scripts into every page; those
 * scripts run in the page's global scope and reference their own globals
 * (`__firefox__`, `__gCrWeb`, `__brave`, `webkit.messageHandlers`). When one of
 * them throws (a browser-timing quirk, seen live at DWeb Camp:
 * `ReferenceError: Can't find variable: __firefox__`), it is NOT our app failing —
 * but the handler would nuke a perfectly working app. Likewise, cross-origin
 * scripts surface only as a detail-free `"Script error."` with no Error object.
 *
 * This filter keeps the crash screen for genuine same-origin app errors while
 * ignoring foreign noise. Safari injects nothing, which is exactly why the app
 * worked there and crashed in Firefox/Brave.
 */

const INJECTED_GLOBAL_MARKERS = /__firefox__|__gCrWeb|__brave|webkit\.messageHandlers/

export function isForeignError(message: string | undefined, hasErrorObject: boolean): boolean {
  const msg = message ?? ''
  // Cross-origin errors are reported without an Error object as a bare "Script error.".
  if (!hasErrorObject && (msg === '' || msg === 'Script error.')) return true
  // Browser-injected content scripts reference their own globals.
  if (INJECTED_GLOBAL_MARKERS.test(msg)) return true
  return false
}
