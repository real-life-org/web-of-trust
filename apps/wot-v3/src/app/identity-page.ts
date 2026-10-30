// An identity flow started in the open app (protection, delete) is a page in the shell's content
// column, with the sidebar (app/layout.ts identityFrame). The gate renders the flow into a host element
// of its own and hands the shell the slot to hang it in; the shell gives the page its column and ends
// the flow when another area is chosen in the sidebar.
import { createContext, useContext } from 'react'

export interface IdentityPage {
  /** the ref of the slot in the content column */
  readonly place: (slot: HTMLElement | null) => void
  /** ask the flow to end (another area chosen in the sidebar); false = it holds and the page stays */
  readonly leave: () => boolean
}

export const IdentityPageContext = createContext<IdentityPage | null>(null)

const NONE = { active: false, place: () => undefined, leave: () => true } as const

/** `active`: an identity flow is the page; `place` goes to the slot's ref only */
export function useIdentityPage(): IdentityPage & { readonly active: boolean } {
  const page = useContext(IdentityPageContext)
  return page ? { active: true, place: page.place, leave: page.leave } : NONE
}
