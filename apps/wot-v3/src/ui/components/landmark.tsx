// The page's one main landmark (WCAG 1.3.1, axe landmark-one-main / region). The shell puts its
// list and detail panes in it; a flow page without navigation (unlock, setup, restore) makes its own
// main around header, content and footer. Nested use renders a div or a named section (a region), so
// there is never a second or nested main.
import { createContext, useContext, type ReactNode } from 'react'

const InMain = createContext(false)

/** main when the page has none yet; inside one, `nested` (a named section is a region) */
export function MainLandmark({
  className,
  labelledBy,
  nested = 'div',
  children,
}: {
  className?: string
  labelledBy?: string
  nested?: 'div' | 'section'
  children: ReactNode
}) {
  const inMain = useContext(InMain)
  // a named section stays a section either way, only its role changes: a page that moves into or out
  // of the shell's main (the end of a delete) keeps its subtree
  if (nested === 'section') {
    return (
      <InMain.Provider value={true}>
        <section className={className} role={inMain ? undefined : 'main'} aria-labelledby={labelledBy}>
          {children}
        </section>
      </InMain.Provider>
    )
  }
  if (inMain) {
    return <div className={className}>{children}</div>
  }
  return (
    <InMain.Provider value={true}>
      <main className={className} aria-labelledby={labelledBy}>
        {children}
      </main>
    </InMain.Provider>
  )
}

/** Content that hangs inside a main landmark rendered elsewhere in the tree (a page the shell's column
 *  holds through a portal): its own MainLandmark nests instead of opening a second main. */
export function InsideMain({ when, children }: { when: boolean; children: ReactNode }) {
  const outer = useContext(InMain)
  return <InMain.Provider value={when || outer}>{children}</InMain.Provider>
}
