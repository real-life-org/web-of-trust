// Identity gate (architecture §4.2 boot matrix; legacy IdentityManagement.tsx as the "Weiche"):
// follows routeFor(identity), keeps a running flow until it exits even when the identity changes
// underneath (onboarding still shows "done" after the activation, unlock still offers biometrics),
// and hands flows to each other: import → recovery, cancel → unlock or welcome, lost biometrics →
// recovery or delete, interrupted delete → unlock for the deregistration → delete.
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import type { IdentityState, LockInfo } from '../port'
import {
  IdentityActionsProvider,
  routeFor,
  useBackgroundLock,
  useBackInFlow,
  useDeleteIdentity,
  useIdentity,
  useIdentityCommands,
  useLegacyReset,
  useOnboarding,
  useProtection,
  useRecovery,
  useScreenCover,
  useScreenshotNotice,
  useUnlock,
  type DeleteEntry,
  type DeleteState,
  type LegacyState,
  type ProtectionState,
  type SetupState,
  type UnlockMode,
  type UnlockState,
} from '../hooks'
import { DeleteScreen } from '../screens/identity/DeleteScreen'
import { IdentityStatusScreen } from '../screens/identity/IdentityStatusScreen'
import { LegacyResetScreen } from '../screens/identity/LegacyResetScreen'
import { OnboardingScreen } from '../screens/identity/OnboardingScreen'
import { ProtectionScreen } from '../screens/identity/ProtectionScreen'
import { RecoveryScreen } from '../screens/identity/RecoveryScreen'
import { UnlockScreen, type UnlockNotice } from '../screens/identity/UnlockScreen'

export type ActiveFlow =
  | { readonly kind: 'onboarding'; readonly hint: Hint }
  | { readonly kind: 'recovery'; readonly hasIdentity: boolean }
  | { readonly kind: 'unlock'; readonly mode: UnlockMode; readonly lock: LockInfo }
  | { readonly kind: 'delete'; readonly entry: DeleteEntry }
  | { readonly kind: 'legacy'; readonly resume: boolean }
  | { readonly kind: 'protection' }

export type { FlowOverride } from './flow-override'
import type { FlowOverride, Hint } from './flow-override'
import { VerifyView } from '../screens/verify/VerifyScreen'
import { ReportCatalogView } from './report-catalog'

function lockOf(identity: IdentityState): LockInfo | null {
  if (identity.status === 'locked' || (identity.status === 'resuming' && identity.step === 'setup')) {
    const { protection, biometric, biometricLost, bioUnusable, unsupported, offerBiometric } = identity
    return { protection, biometric, biometricLost, bioUnusable, unsupported, offerBiometric }
  }
  if (identity.status === 'resuming' && identity.step === 'wipe') return identity.lock
  return null
}

function fromRoute(identity: IdentityState): ActiveFlow | null {
  const route = routeFor(identity)
  if (route.kind !== 'flow') return null
  switch (route.flow) {
    case 'onboarding':
      return { kind: 'onboarding', hint: route.hint }
    case 'legacy-reset':
      return { kind: 'legacy', resume: route.resume }
    case 'unlock': {
      const lock = lockOf(identity)
      return lock ? { kind: 'unlock', mode: route.mode, lock } : null
    }
    case 'delete-resume':
      return identity.status === 'resuming' && identity.step === 'wipe'
        ? { kind: 'delete', entry: { kind: 'resume', phase: identity.phase, lock: identity.lock } }
        : null
  }
}

export function IdentityGate({ children, override, start: startFlow }: { children: ReactNode; override?: FlowOverride | undefined; start?: 'recovery' | undefined }) {
  const identity = useIdentity()
  const commands = useIdentityCommands()
  // the flow on screen; null = follow the identity state. `seq` keys a fresh mount per started flow.
  const [pinned, setPinned] = useState<{ flow: ActiveFlow; seq: number } | null>(() =>
    startFlow === 'recovery' ? { flow: { kind: 'recovery', hasIdentity: false }, seq: -1 } : null,
  )
  const counter = useRef(0)
  const start = useCallback((flow: ActiveFlow | null) => {
    counter.current += 1
    setPinned(flow ? { flow, seq: counter.current } : null)
  }, [])
  // the device lifecycle (§5): cover while open, lock after the background delay, and say so on the
  // unlock screen until the next unlock
  const [lockedInBackground, setLockedInBackground] = useState(false)
  useBackgroundLock(() => setLockedInBackground(true))
  useScreenCover()
  if (lockedInBackground && identity.status === 'unlocked') setLockedInBackground(false)
  const routed = useMemo(() => fromRoute(identity), [identity])
  // a routed flow is pinned on first sight (same key, no remount), so a later identity change does not unmount it
  // (state adjusted during render, React's pattern for deriving state from a changed input)
  if (!pinned && routed) setPinned({ flow: routed, seq: 0 })
  const current = pinned ?? (routed ? { flow: routed, seq: 0 } : null)

  const actions = useMemo(
    () => ({
      openProtection: () => start({ kind: 'protection' }),
      openDelete: () => start({ kind: 'delete', entry: { kind: 'start' } }),
      lock: () => void commands.lock('user'),
    }),
    [start, commands],
  )

  if (override) return <OverrideView override={override} />

  if (current) {
    const key = `${current.flow.kind}:${current.seq}`
    const done = () => start(null)
    switch (current.flow.kind) {
      case 'onboarding':
        return <OnboardingFlow key={key} hint={current.flow.hint} onExit={(s) => (s.name === 'exit' && s.to === 'recovery' ? start({ kind: 'recovery', hasIdentity: false }) : done())} />
      case 'recovery':
        return <RecoveryFlow key={key} hasIdentity={current.flow.hasIdentity} onExit={done} />
      case 'unlock':
        return (
          <UnlockFlow
            key={key}
            lock={current.flow.lock}
            mode={current.flow.mode}
            notice={lockedInBackground ? 'background-timeout' : null}
            onExit={(s) => {
              if (s.name !== 'exit') return done()
              if (s.to === 'recovery') return start({ kind: 'recovery', hasIdentity: true })
              if (s.to === 'delete') return start({ kind: 'delete', entry: { kind: 'start' } })
              if (s.to === 'delete-resume') return start({ kind: 'delete', entry: { kind: 'after-unlock' } })
              return done()
            }}
          />
        )
      case 'delete':
        return (
          <DeleteFlow
            key={key}
            entry={current.flow.entry}
            onExit={(s) => {
              if (s.name === 'exit' && s.to === 'unlock-for-deregistration') {
                const lock = lockOf(identity)
                if (lock) return start({ kind: 'unlock', mode: 'delete-dereg', lock })
              }
              // #416: closing the dialog before the confirmation changes nothing; only a finished
              // delete reconciles the storage again
              if (s.name === 'exit' && s.to === 'welcome') void commands.refresh()
              done()
            }}
          />
        )
      case 'legacy':
        return <LegacyFlow key={key} resume={current.flow.resume} onExit={done} />
      case 'protection':
        return identity.status === 'unlocked' ? (
          <ProtectionFlow key={key} current={identity.protection} biometric={identity.biometric} onExit={done} />
        ) : null
    }
  }

  const route = routeFor(identity)
  if (route.kind === 'screen') return <IdentityStatusScreen status={route.screen} onRetry={() => void commands.refresh()} />
  return <IdentityActionsProvider value={actions}>{children}</IdentityActionsProvider>
}

// ── flow containers: hook + back button + screen ─────────────────────────────

function OnboardingFlow({ hint, onExit }: { hint: Hint; onExit: (s: SetupState) => void }) {
  const { state, send } = useOnboarding(onExit)
  const [captured, setCaptured] = useState(false)
  const words = state.name === 'showWords' || state.name === 'lastWarning' || state.name === 'verifyWords'
  useScreenshotNotice(() => setCaptured(true), words)
  useBackInFlow(() => send({ type: 'back' }))
  return <OnboardingScreen state={state} send={send} hint={hint} captured={captured} />
}

function RecoveryFlow({ hasIdentity, onExit }: { hasIdentity: boolean; onExit: (s: SetupState) => void }) {
  const { state, send } = useRecovery({ hasIdentity }, onExit)
  const [captured, setCaptured] = useState(false)
  useScreenshotNotice(() => setCaptured(true), state.name === 'enterWords')
  useBackInFlow(() => send({ type: 'back' }))
  return <RecoveryScreen state={state} send={send} captured={captured} />
}

function UnlockFlow({ lock, mode, notice, onExit }: { lock: LockInfo; mode: UnlockMode; notice: UnlockNotice; onExit: (s: UnlockState) => void }) {
  const { state, send } = useUnlock(lock, mode, onExit)
  return <UnlockScreen state={state} send={send} notice={notice} />
}

function DeleteFlow({ entry, onExit }: { entry: DeleteEntry; onExit: (s: DeleteState) => void }) {
  const { state, send } = useDeleteIdentity(entry, onExit)
  useBackInFlow(() => send({ type: 'back' }))
  return <DeleteScreen state={state} send={send} />
}

function LegacyFlow({ resume, onExit }: { resume: boolean; onExit: (s: LegacyState) => void }) {
  const { state, send } = useLegacyReset(resume, onExit)
  // the reset has no way back (§4.2 "gesperrt"): back does nothing and never leaves the app mid-reset
  useBackInFlow(() => undefined)
  return <LegacyResetScreen state={state} send={send} />
}

function ProtectionFlow({
  current,
  biometric,
  onExit,
}: {
  current: Extract<IdentityState, { status: 'unlocked' }>['protection']
  biometric: Extract<IdentityState, { status: 'unlocked' }>['biometric']
  onExit: (s: ProtectionState) => void
}) {
  const { state, send } = useProtection(current, biometric, onExit)
  useBackInFlow(() => send({ type: 'back' }))
  return <ProtectionScreen state={state} send={send} />
}

const noop = () => {}

function OverrideView({ override: o }: { override: FlowOverride }) {
  switch (o.flow) {
    case 'onboarding':
      return <OnboardingScreen state={o.state} send={noop} hint={o.hint ?? null} captured={o.captured ?? false} />
    case 'recovery':
      return <RecoveryScreen state={o.state} send={noop} captured={o.captured ?? false} />
    case 'unlock':
      return <UnlockScreen state={o.state} send={noop} notice={o.notice ?? null} />
    case 'protection':
      return <ProtectionScreen state={o.state} send={noop} />
    case 'delete':
      return <DeleteScreen state={o.state} send={noop} />
    case 'legacy':
      return <LegacyResetScreen state={o.state} send={noop} />
    case 'status':
      return <IdentityStatusScreen status={o.status} onRetry={noop} />
    case 'verify':
      return <VerifyView state={o.state} send={noop} />
    case 'report':
      return <ReportCatalogView state={o.state} blocked={o.blocked ?? false} />
  }
}
