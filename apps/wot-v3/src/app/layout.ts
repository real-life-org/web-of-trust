// The frames of the app (canvas "WoT v3 Desktop-Layout", Anton 29.10.): the one place that decides
// what the shell shows and in which frame a flow appears.
//
// 1. App: the sidebar is always there (unless the app is locked). Two content columns only where there
//    is content: the list with its conversation. An empty list, an area not built yet (groups) and the
//    profile are one column; never a list next to "pick a conversation".
// 2. Page: a flow (verify, report, the identity flows started in the open app) is a page in the content
//    column, with the sidebar; no columns while it runs. Unlock, setup and restore are a whole page
//    without navigation.
// 3. Dialog: only for one question over whatever is shown (counter-verification, success); the panes do
//    not know about it.
//
// None of this depends on the viewport: the phone shows the same panes one at a time, and nothing
// remounts when a window crosses the breakpoint of the columns.

import type { Route, Tab } from './nav'

/** the media query of the shell's columns (Tailwind `md`) */
export const WIDE_QUERY = '(min-width: 48rem)'

const PAGE_ROUTES: ReadonlySet<Route['kind']> = new Set(['verify', 'report'])

/** a page: an act with its own steps and an end, not a detail of the list (messenger pattern) */
export function isPageRoute(route: Route): boolean {
  return PAGE_ROUTES.has(route.kind)
}

export interface ShellPanes {
  /** columns: list + detail; single: the area alone (empty, placeholder, profile); page: a flow */
  readonly mode: 'columns' | 'single' | 'page'
  /** the route of the detail column (phone: the screen over the list) */
  readonly detail: Route | null
  /** the flow shown as a page in the content column */
  readonly page: Route | null
  /** phone: the list gives way to whatever is open */
  readonly listHidden: boolean
}

/** What the shell shows for a navigation stack in an area. `empty`: the area has nothing to pick from
 *  (no contacts yet, a placeholder, the profile). A page is only ever the top entry; the detail is the
 *  newest entry that is not a page. */
export function shellPanes(stack: readonly Route[], area: { readonly tab: Tab; readonly empty: boolean }): ShellPanes {
  const top = stack[stack.length - 1] ?? null
  const listHidden = stack.length > 0
  if (top && isPageRoute(top)) return { mode: 'page', detail: null, page: top, listHidden }
  let detail: Route | null = null
  for (let i = stack.length - 1; i >= 0; i--) {
    const r = stack[i]
    if (r && !isPageRoute(r)) {
      detail = r
      break
    }
  }
  const columns = detail !== null || (area.tab === 'contacts' && !area.empty)
  return { mode: columns ? 'columns' : 'single', detail, page: null, listHidden }
}

export type IdentityFlowKind = 'onboarding' | 'recovery' | 'unlock' | 'delete' | 'legacy' | 'protection'

/** Where an identity flow appears: `app` = a page in the content column with the sidebar (started in
 *  the open app), `standalone` = a whole page without navigation (the app is locked or has no identity). */
export function identityFrame(flow: IdentityFlowKind, unlocked: boolean): 'app' | 'standalone' {
  return unlocked && (flow === 'protection' || flow === 'delete') ? 'app' : 'standalone'
}
