// The page frame (canvas "WoT v3 Desktop-Layout", frame 2 "Seite", Anton 29.10.): a flow is a page.
// On the phone it is the full screen, as before. On the desktop it is a page in the content column next
// to the sidebar (variant `app`: verify, report, the identity flows started in the open app), or the
// whole window without navigation under a header with the app's logo (variant `standalone`: unlock,
// setup, restore). FlowPage reads the frame and lays out its header, column and footer for it.
//
// What a flow keeps on the desktop (E5): it never ends by accident (there is nothing beside it to click
// away), the page takes the focus when it opens unless a field took it (the unlock's password), Escape
// is the flow's back except in a text field that holds something, and focus returns to where it was
// when the page closes. The frame never changes its tree with the viewport, so nothing remounts when a
// window crosses the breakpoint.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { InsideMain } from './landmark'
import { AppMark } from './Navigation'

export interface PageFrameValue {
  /** app: a page in the content column, with the sidebar; standalone: the whole window, no navigation */
  readonly variant: 'app' | 'standalone'
  /** laid out for the desktop (from the breakpoint of the columns) */
  readonly wide: boolean
  /** app: the area the page leads back to (“‹ Contacts”) */
  readonly area: string | null
}

const Frame = createContext<PageFrameValue | null>(null)

/** the frame a FlowPage is in (null: none, e.g. a detail of the shell) */
export function usePageFrame(): PageFrameValue | null {
  return useContext(Frame)
}

/** marks the element the page focuses when it opens (FlowPage's title) */
export const PAGE_TITLE_ATTR = 'data-page-title'

export function PageFrame({
  variant,
  wide,
  area = null,
  onEscape,
  children,
}: {
  variant: 'app' | 'standalone'
  wide: boolean
  area?: string | null
  /** Escape on the desktop: the flow's back (the caller passes the system back) */
  onEscape: () => void
  children: ReactNode
}) {
  const root = useRef<HTMLDivElement | null>(null)
  const value = useMemo(() => ({ variant, wide, area }), [variant, wide, area])
  const escape = useRef(onEscape)
  const isWide = useRef(wide)
  useEffect(() => {
    escape.current = onEscape
    isWide.current = wide
  })
  // where the focus was when the page opened; read at the first render, before the page replaces the
  // columns and the browser moves the focus away
  const [opener] = useState(() =>
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null,
  )

  // the page takes the focus when it opens (desktop), named by its title, unless a field took it
  useEffect(() => {
    const el = root.current
    if (!isWide.current || !el || el.contains(document.activeElement)) return
    const title = el.querySelector<HTMLElement>(`[${PAGE_TITLE_ATTR}]`)
    ;(title ?? el).focus({ preventScroll: true })
  }, [])

  // and gives it back when it closes
  useEffect(
    () => () => {
      if (isWide.current && opener?.isConnected) opener.focus({ preventScroll: true })
    },
    [opener],
  )

  // Escape is the flow's back on the desktop; a dialog over the page and a filled text field keep it
  useEffect(() => {
    if (!wide) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const target = e.target
      if (target instanceof Element && target.closest('[role=dialog],[role=alertdialog]')) return
      if (keepsEscape(target)) return
      e.preventDefault()
      escape.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [wide])

  return (
    <Frame.Provider value={value}>
      <div ref={root} tabIndex={-1} data-slot="page" data-variant={variant} className="flex min-h-0 flex-1 flex-col outline-none">
        {/* in the app the page hangs in the shell's main (also through a portal): a named region there */}
        <InsideMain when={variant === 'app'}>{children}</InsideMain>
      </div>
    </Frame.Provider>
  )
}

/** The window of a page without navigation: on the desktop a header with the app's logo above it. */
export function StandalonePage({ appName, children }: { appName: string; children: ReactNode }) {
  return (
    <div data-slot="standalone-page" className="flex min-h-0 flex-1 flex-col bg-background text-foreground">
      <header className="hidden h-16 flex-none items-center border-b border-border bg-card px-6 md:flex">
        <AppMark appName={appName} />
      </header>
      {children}
    </div>
  )
}

const NOT_TEXT = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'])

/** Escape in a text field that holds something stays with the field (Anton 29.10., review 473 H1):
 *  on the desktop Escape is pressed in passing (closing an autofill list), and as the flow's back it
 *  would drop what was typed. In an empty field or outside a field it is the flow's back. */
export function keepsEscape(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return target.value !== ''
  if (target instanceof HTMLInputElement) return !NOT_TEXT.has(target.type) && target.value !== ''
  return target instanceof HTMLElement && target.isContentEditable && (target.textContent ?? '') !== ''
}

/** A subtree rendered once into a host element of its own, which moves between slots: the flow keeps
 *  its state when its frame changes (an identity flow that leaves the shell because the identity went
 *  away, e.g. at the end of a delete). `placed` turns true once the host hangs in the document, so a
 *  first step's autoFocus finds it attached (review 473 F1). */
export function usePortalHost(): { readonly host: HTMLElement; readonly placed: boolean; readonly place: (slot: HTMLElement | null) => void } {
  const [host] = useState(() => {
    const el = document.createElement('div')
    el.className = 'flex min-h-0 flex-1 flex-col'
    return el
  })
  const [placed, setPlaced] = useState(false)
  const place = useCallback(
    (slot: HTMLElement | null) => {
      if (!slot) {
        setPlaced(host.isConnected)
        return
      }
      if (host.parentElement !== slot) slot.appendChild(host)
      setPlaced(true)
    },
    [host],
  )
  return { host, placed, place }
}
