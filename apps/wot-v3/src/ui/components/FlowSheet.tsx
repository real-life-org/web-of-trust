// The frame of a flow (handshake UX round 2.3, E5): the full screen on the phone, a centered sheet in
// phone width on the desktop. Built on the dialog family's Sheet (Radix: focus trap, aria-modal, the
// rest of the page hidden from assistive technology and unreachable by pointer); the caller decides
// which (app/layout.ts) and makes its own background inert.
//
// The flow's subtree never remounts when the presentation changes (a phone turned to landscape, a
// window resized across the breakpoint): it is rendered once into a host element of its own, and only
// that element moves between the inline slot and the sheet. A remount would restart the flow, e.g.
// draw new recovery words in the middle of the onboarding.
//
// Closing: the header's × and back are the flow's own; Escape is the system back (the caller passes
// it), so all three take the same way. A click beside the sheet does nothing (E5: a flow must not end
// by accident).
import { createContext, useCallback, useContext, useId, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Sheet, SheetContent, cn } from '../primitives'
import { AppMark } from './Navigation'

const FlowTitle = createContext<string | null>(null)

/** the id the flow's page title takes, so the sheet is named by it (null outside a FlowSheet) */
export function useFlowTitleId(): string | null {
  return useContext(FlowTitle)
}

const HOST_CLASS = 'flex min-h-0 flex-1 flex-col'

export function FlowSheet({
  as,
  calm = false,
  appName,
  label,
  onEscape,
  children,
}: {
  /** screen: inline, full size of its container; sheet: the centered dialog */
  as: 'screen' | 'sheet'
  /** the identity flows: a calm background with the app's mark instead of the dimmed shell */
  calm?: boolean
  appName: string
  /** the sheet's name while the flow's page has no title on screen (e.g. still loading) */
  label: string
  onEscape: () => void
  children: ReactNode
}) {
  const titleId = useId()
  const [host] = useState(() => {
    const el = document.createElement('div')
    el.className = HOST_CLASS
    return el
  })
  const place = useCallback((slot: HTMLElement | null) => {
    if (slot && host.parentElement !== slot) slot.appendChild(host)
  }, [host])
  // focus comes back where it was when the flow opened (Radix would send it to a trigger; there is none).
  // Read at the first render, before the shell behind turns inert and the browser moves focus away.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null))
  const content = <FlowTitle.Provider value={titleId}>{children}</FlowTitle.Provider>

  return (
    <>
      {createPortal(content, host)}
      {as === 'screen' ? (
        <div ref={place} data-slot="flow-screen" className="contents" />
      ) : (
        <>
          {calm ? <CalmBackground appName={appName} /> : null}
          <Sheet open modal>
            <SheetContent
              data-slot="flow-sheet"
              aria-modal="true"
              aria-labelledby={titleId}
              aria-label={label}
              aria-describedby={undefined}
              overlayClassName={calm ? 'bg-transparent' : undefined}
              className={cn(
                'flex flex-col overflow-hidden bg-background p-0',
                'md:h-[min(760px,calc(100dvh-4rem))] md:max-h-none md:max-w-[390px] md:pb-0',
              )}
              // the sheet itself takes the focus (named by its title), not its first button: no stray
              // focus ring on × or the primary action, and Tab starts at the top
              onOpenAutoFocus={(e) => {
                e.preventDefault()
                if (e.currentTarget instanceof HTMLElement) e.currentTarget.focus()
              }}
              onCloseAutoFocus={(e) => {
                e.preventDefault()
                if (opener?.isConnected) opener.focus()
              }}
              onEscapeKeyDown={(e) => {
                e.preventDefault()
                onEscape()
              }}
              onPointerDownOutside={(e) => e.preventDefault()}
              onInteractOutside={(e) => e.preventDefault()}
            >
              <div ref={place} className="contents" />
            </SheetContent>
          </Sheet>
        </>
      )}
    </>
  )
}

/** the background of the identity flows on the desktop: no columns, the app's mark top left */
function CalmBackground({ appName }: { appName: string }) {
  return (
    <div aria-hidden className="flex min-h-0 flex-1 flex-col bg-muted">
      <AppMark appName={appName} className="px-6 pt-5" />
    </div>
  )
}
