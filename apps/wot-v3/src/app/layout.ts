// Where a flow appears (handshake UX round 2.3, E5 Anton 29.10.): the one place that decides between
// the screen and the sheet. On the phone a flow is the full screen, as before. From the breakpoint of
// the shell's columns (md, 48rem) a flow is a centered sheet in phone width over the shell, the shell
// dimmed and inert behind it; the identity flows (onboarding, recovery, unlock, …) are the same sheet
// on a calm background without columns. Flows are not details: verify and report never take the
// detail column, which keeps showing what was there before.

import type { Route } from './nav'

/** a flow: an act with its own steps and an end, not a detail of the list (messenger pattern) */
export type FlowPresentation = 'screen' | 'sheet'

/** the media query of the shell's columns (Tailwind `md`) */
export const WIDE_QUERY = '(min-width: 48rem)'

const FLOW_ROUTES: ReadonlySet<Route['kind']> = new Set(['verify', 'report'])

export function isFlowRoute(route: Route): boolean {
  return FLOW_ROUTES.has(route.kind)
}

export function flowPresentation(wide: boolean): FlowPresentation {
  return wide ? 'sheet' : 'screen'
}

export interface ShellPanes {
  /** the route of the detail column (desktop) or of the full screen (phone, no flow on top) */
  readonly detail: Route | null
  /** the flow on top of the stack and how it is shown */
  readonly flow: { readonly route: Route; readonly as: FlowPresentation } | null
  /** phone: the list gives way to whatever is open */
  readonly listHidden: boolean
}

/** What the shell shows for a navigation stack. A flow is only ever the top entry; the detail is the
 *  newest entry below it that is not a flow. On the phone the flow covers the detail, which is not
 *  rendered then (as before: one screen at a time). */
export function shellPanes(stack: readonly Route[], wide: boolean): ShellPanes {
  const top = stack[stack.length - 1] ?? null
  const flow = top && isFlowRoute(top) ? { route: top, as: flowPresentation(wide) } : null
  const below = flow ? stack.slice(0, -1) : stack
  let detail: Route | null = null
  for (let i = below.length - 1; i >= 0; i--) {
    const r = below[i]
    if (r && !isFlowRoute(r)) {
      detail = r
      break
    }
  }
  return { detail: flow?.as === 'screen' ? null : detail, flow, listHidden: stack.length > 0 }
}
