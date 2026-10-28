// The interop probe of the developer area (Delivery 0.85 §4.6, VTI Mediator Adapter Profile 0.29 §3b,
// §5): one sealed envelope carried as a `sealed-envelope/0.1` document in the Trust Tasks TSP binding to
// the TSP identifier of a foreign agent, without a contact, a relationship or holder data, and the
// agent's answer (`trust-task-error`, `trust-task-next-step`) shown in a delivery line. Present on the
// port only in a build that enables it (never a store build).

import type { ReadStore } from './store'
import type { DeliveryState } from './models'

export type InteropProbeState =
  | { readonly phase: 'idle' }
  /** the entered identifier is no Ed25519 did:key (RLTP-VTI-1210) */
  | { readonly phase: 'invalid' }
  /** the probe could not start: the mediator was not reached or refused the throwaway identity */
  | { readonly phase: 'unreachable' }
  | {
      readonly phase: 'running'
      readonly counterpart: string
      /** the sending form of the last deposit, null before the first */
      readonly mode: 'routed' | 'direct' | null
      readonly delivery: DeliveryState | null
    }

export interface InteropProbe {
  /** C, the mediator of this build */
  readonly mediator: string
  readonly state: ReadStore<InteropProbeState>
  /** ends a running probe and sends one carried document to `counterpart` (a did:key) */
  send(counterpart: string): void
  /** ends a running probe: its wire closes */
  stop(): void
}
