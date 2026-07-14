// IndexedDB-Verfügbarkeits-Guard.
//
// Echte iOS-Nutzer (Safari + alle WebKit-Browser) mit iOS-Sperrmodus, einer
// Privacy-/Blocker-App oder „Alle Cookies blockieren" haben KEIN IndexedDB im
// window. Die App läuft heute durchs Onboarding (in-memory) und crasht erst beim
// ersten durablen Write mit dem rohen WebKit-Fehler „Can't find variable:
// indexedDB". Deshalb prüfen wir früh beim Start, ob IndexedDB nutzbar ist, und
// zeigen sonst eine freundliche, vollbild-blockierende Meldung — BEVOR React die
// Adapter (die IndexedDB anfassen) initialisiert.
//
// Wichtig: Dieser Guard darf NICHT von localStorage, dem i18n-Framework oder
// irgendeinem Adapter abhängen — in demselben Browser-Modus kann auch
// localStorage werfen. Also reines Plain-DOM, zweisprachig via navigator.language
// (analog zum bestehenden Plain-DOM-Fehler-Pattern in main.tsx).

const PROBE_DB_NAME = 'wot-storage-probe'
const PROBE_TIMEOUT_MS = 4000

/**
 * Prüft, ob IndexedDB auf diesem Gerät tatsächlich nutzbar ist.
 *
 * - `typeof indexedDB === 'undefined'` → sofort `false` (iOS-Sperrmodus/Private).
 * - Synchroner Wurf beim `indexedDB.open(...)` → `false`.
 * - `onerror` / `onblocked` → `false`.
 * - `onsuccess` → DB schließen, best-effort löschen, `true`.
 * - Timeout (4s) → `true` (ein langsames, aber funktionierendes Gerät nicht
 *   fälschlich blockieren; die eindeutigen Blockier-Fälle sind schon abgedeckt).
 */
export async function probeIndexedDB(): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false

  return new Promise<boolean>((resolve) => {
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      resolve(ok)
    }

    // Manche Umgebungen (WebKit im Sperrmodus) werfen SYNCHRON beim open().
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(PROBE_DB_NAME)
    } catch {
      done(false)
      return
    }

    // Langsames, aber funktionierendes Gerät: nicht fälschlich blockieren.
    const timer = setTimeout(() => done(true), PROBE_TIMEOUT_MS)

    req.onsuccess = () => {
      clearTimeout(timer)
      try {
        req.result.close()
      } catch {
        // ignorieren
      }
      try {
        indexedDB.deleteDatabase(PROBE_DB_NAME)
      } catch {
        // Löschen ist best-effort; Fehler ignorieren.
      }
      done(true)
    }

    req.onerror = () => {
      clearTimeout(timer)
      done(false)
    }

    req.onblocked = () => {
      clearTimeout(timer)
      done(false)
    }
  })
}

/**
 * Rendert eine freundliche, vollbild-zentrierte, blockierende Meldung per
 * Plain-DOM (KEIN React, KEIN localStorage, KEIN i18n-Framework).
 */
export function renderStorageBlocked(): void {
  const de = (navigator.language || '').toLowerCase().startsWith('de')

  const t = de
    ? {
        title: 'Lokaler Speicher ist blockiert',
        intro:
          'Dein Browser oder iPhone verhindert, dass Web of Trust deine Identität sicher auf diesem Gerät speichert (IndexedDB ist deaktiviert). Das passiert meist durch eine dieser Einstellungen:',
        steps: [
          'iOS-Sperrmodus ausschalten: Einstellungen → Datenschutz & Sicherheit → Sperrmodus (oder in Safari über das „aA"-Menü → Website-Einstellungen für diese Seite).',
          'Eine Privacy-/Blocker-App (z.B. „Lockdown") für diese Seite deaktivieren.',
          'Privates Surfen beenden und unter Einstellungen → Safari → „Alle Cookies blockieren" ausschalten.',
        ],
        reload: 'Neu laden',
      }
    : {
        title: 'Local storage is blocked',
        intro:
          'Your browser or iPhone is preventing Web of Trust from securely storing your identity on this device (IndexedDB is disabled). This is usually caused by one of these settings:',
        steps: [
          "Turn off iOS Lockdown Mode: Settings → Privacy & Security → Lockdown Mode (or per-site in Safari via the 'aA' menu → Website Settings).",
          "Disable a privacy/blocker app (e.g. 'Lockdown') for this site.",
          "Exit Private Browsing and turn off Settings → Safari → 'Block All Cookies'.",
        ],
        reload: 'Reload',
      }

  const mount = document.getElementById('root') ?? document.body

  // Overlay (Vollbild, zentriert, helles Theme passend zur App).
  const overlay = document.createElement('div')
  overlay.setAttribute(
    'style',
    'box-sizing:border-box;position:fixed;inset:0;z-index:2147483647;' +
      'display:flex;align-items:center;justify-content:center;' +
      'padding:24px;background:#f8fafc;overflow:auto;' +
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" +
      'color:#1e293b;-webkit-text-size-adjust:100%;',
  )

  const card = document.createElement('div')
  card.setAttribute(
    'style',
    'box-sizing:border-box;width:100%;max-width:480px;background:#ffffff;' +
      'border-radius:16px;padding:28px 24px;' +
      'box-shadow:0 10px 30px rgba(15,23,42,0.08);text-align:center;',
  )

  const icon = document.createElement('div')
  icon.setAttribute('style', 'font-size:44px;line-height:1;margin-bottom:12px;')
  icon.textContent = '🔒'

  const title = document.createElement('h1')
  title.setAttribute(
    'style',
    'margin:0 0 12px;font-size:22px;line-height:1.3;font-weight:600;color:#0f172a;',
  )
  title.textContent = t.title

  const intro = document.createElement('p')
  intro.setAttribute(
    'style',
    'margin:0 0 20px;font-size:15px;line-height:1.55;color:#475569;text-align:left;',
  )
  intro.textContent = t.intro

  const list = document.createElement('ol')
  list.setAttribute(
    'style',
    'margin:0 0 24px;padding-left:22px;text-align:left;font-size:15px;' +
      'line-height:1.55;color:#334155;',
  )
  for (const step of t.steps) {
    const li = document.createElement('li')
    li.setAttribute('style', 'margin-bottom:12px;')
    li.textContent = step
    list.appendChild(li)
  }

  const button = document.createElement('button')
  button.setAttribute('type', 'button')
  button.setAttribute(
    'style',
    'box-sizing:border-box;width:100%;border:none;cursor:pointer;' +
      'background:#2563eb;color:#ffffff;font-size:16px;font-weight:600;' +
      'padding:14px 20px;border-radius:12px;font-family:inherit;',
  )
  button.textContent = t.reload
  // CSP-sicher: addEventListener statt inline-onclick-String.
  button.addEventListener('click', () => location.reload())

  card.appendChild(icon)
  card.appendChild(title)
  card.appendChild(intro)
  card.appendChild(list)
  card.appendChild(button)
  overlay.appendChild(card)

  // Vorhandenen Inhalt des Mounts ersetzen (Plain-DOM, kein React).
  mount.textContent = ''
  mount.appendChild(overlay)
}
