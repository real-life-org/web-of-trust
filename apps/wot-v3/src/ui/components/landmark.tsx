// The page's one main landmark (WCAG 1.3.1, axe landmark-one-main / region). The shell puts its
// list and detail panes in it; a full-screen flow page (identity flows outside the shell) makes its
// own main around header, content and footer. Nested use renders a div or a named section (a
// region), so there is never a second or nested main.
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
  if (useContext(InMain)) {
    const Nested = nested
    return (
      <Nested className={className} aria-labelledby={nested === 'section' ? labelledBy : undefined}>
        {children}
      </Nested>
    )
  }
  return (
    <InMain.Provider value={true}>
      <main className={className} aria-labelledby={labelledBy}>
        {children}
      </main>
    </InMain.Provider>
  )
}
