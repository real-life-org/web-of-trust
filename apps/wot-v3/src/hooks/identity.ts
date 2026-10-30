// Identity hooks (architecture §4.1): the flow machines with their effect runner, bound to port and
// platform; screens get `{ state, send }` and small helpers, never the machines themselves.
import { createContext, createElement, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { IdentityState, LockInfo, Mnemonic, ProtectionMode, BiometricKind, Secret } from '../port'
import { secret } from '../port'
import { useI18n } from '../i18n'
import { mnemonicWords } from '../lib/mnemonic-format'
import { deleteAfterUnlock, deleteMachine, deleteResume, deleteStart, type DeleteEvent, type DeleteState } from '../flows/delete'
import { legacyReset, legacyStart, type LegacyEvent, type LegacyState } from '../flows/legacy-reset'
import type { Effect, Machine, Step } from '../flows/machine'
import { protection, protectionStart, type ProtectionEvent, type ProtectionState } from '../flows/protection'
import { onboarding, onboardingStart, recovery, recoveryStart, type SetupEvent, type SetupState, type WordsCheck } from '../flows/setup'
import { unlock, unlockStart, type UnlockEvent, type UnlockMode, type UnlockState } from '../flows/unlock'
import { createFlowRunner, identityExecutor, type EffectTexts, type FlowRunner } from './flow-runner'
import { usePlatform, usePort } from './context'
import { useStore } from './useStore'

export type { SetupState, SetupEvent, WordsCheck } from '../flows/setup'
export type { UnlockState, UnlockEvent, UnlockMode } from '../flows/unlock'
export type { ProtectionState, ProtectionEvent, ProtectionTarget } from '../flows/protection'
export type { DeleteState, DeleteEvent } from '../flows/delete'
export type { LegacyState, LegacyEvent } from '../flows/legacy-reset'
export type { IdentityRoute } from '../flows/boot'
export { routeFor } from '../flows/boot'
export { MIN_PASSPHRASE } from '../flows/setup'
/** Wrap field values as secrets before they enter a machine (architecture §5). */
export { secret }

export interface Flow<S, E> {
  readonly state: S
  readonly send: (e: E) => void
}

export function useIdentity(): IdentityState {
  return useStore(usePort().stores.identity)
}

function useTexts(): EffectTexts {
  const { t } = useI18n()
  return useMemo(
    () => ({
      unlockPrompt: { title: t.biometricPrompt.unlockTitle, subtitle: t.biometricPrompt.subtitle, cancel: t.biometricPrompt.cancel },
      enrollPrompt: { title: t.biometricPrompt.enrollTitle, subtitle: t.biometricPrompt.subtitle, cancel: t.biometricPrompt.cancel },
    }),
    [t],
  )
}

type ExecKey = 'setup' | 'unlock' | 'protection' | 'delete' | 'legacy'

/** Leaving an identity page from outside the flow (another area in the sidebar): the gate asks the
 *  running flow, and the flow's machine decides with a `close` event, as for × and Escape. True = the
 *  flow ended; false = it holds (a protection change applying, a delete past its confirmation). */
export type LeaveRequest = () => boolean
export const FlowLeaveContext = createContext<((request: LeaveRequest | null) => void) | null>(null)
/** the flows whose machines take `close` and run as a page in the open app */
const LEAVABLE: ReadonlySet<ExecKey> = new Set(['protection', 'delete'])

/** One runner per mounted flow, created in an effect (StrictMode-safe), disposed on unmount, which
 *  also resets the screen protection. Until the runner exists, the start state renders. */
function useFlow<S extends { readonly name: string; readonly run: number }, E, F extends Effect>(
  machine: Machine<S, E, F>,
  start: () => Step<S, F> | S,
  exec: ExecKey,
  onExit: ((state: S) => void) | undefined,
  override?: S | null,
): Flow<S, E> {
  const port = usePort()
  const platform = usePlatform()
  const registerLeave = useContext(FlowLeaveContext)
  const texts = useTexts()
  const textsRef = useRef(texts)
  useEffect(() => {
    textsRef.current = texts
  }, [texts])
  const [first] = useState(start)
  const [runner, setRunner] = useState<FlowRunner<S, E> | null>(null)
  useEffect(() => {
    if (override) return
    // texts are read at effect time, so a language switch does not restart the flow
    const executor = identityExecutor(port, platform, {
      get unlockPrompt() {
        return textsRef.current.unlockPrompt
      },
      get enrollPrompt() {
        return textsRef.current.enrollPrompt
      },
    })
    const r = createFlowRunner(machine, first, executor[exec] as unknown as (f: F) => Promise<{ ok: boolean }>, platform)
    setRunner(r)
    if (LEAVABLE.has(exec))
      registerLeave?.(() => {
        r.send({ type: 'close' } as E)
        return r.get().name === 'exit'
      })
    return () => {
      if (LEAVABLE.has(exec)) registerLeave?.(null)
      r.dispose()
    }
    // the runner lives as long as the component that started the flow
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const initial = 'state' in first && 'effects' in first ? first.state : (first as S)
  const subscribe = runner ? runner.subscribe : noSubscribe
  const get = runner ? runner.get : () => override ?? initial
  const state = useSyncExternalStore(subscribe, get, get)
  const exited = state.name === 'exit'
  useEffect(() => {
    if (exited) onExit?.(state)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exited])
  return { state, send: runner ? runner.send : noop }
}

const noSubscribe = () => () => {}
const noop = () => {}

export function useOnboarding(onExit?: (s: SetupState) => void, override?: SetupState | null): Flow<SetupState, SetupEvent> {
  const port = usePort()
  return useFlow(onboarding, () => onboardingStart(port.identity.termsConsent().current), 'setup', onExit, override)
}

export function useRecovery(opts: { hasIdentity: boolean }, onExit?: (s: SetupState) => void, override?: SetupState | null): Flow<SetupState, SetupEvent> {
  const port = usePort()
  return useFlow(
    recovery,
    () => {
      const c = port.identity.termsConsent()
      return recoveryStart({ hasIdentity: opts.hasIdentity, termsValid: c.valid, termsVersion: c.current })
    },
    'setup',
    onExit,
    override,
  )
}

export function useUnlock(lock: LockInfo, mode: UnlockMode, onExit?: (s: UnlockState) => void, override?: UnlockState | null): Flow<UnlockState, UnlockEvent> {
  return useFlow(unlock, () => unlockStart(lock, mode), 'unlock', onExit, override)
}

export function useProtection(
  current: ProtectionMode,
  biometric: BiometricKind | null,
  onExit?: (s: ProtectionState) => void,
  override?: ProtectionState | null,
): Flow<ProtectionState, ProtectionEvent> {
  return useFlow(protection, () => protectionStart(current, biometric), 'protection', onExit, override)
}

export type DeleteEntry = { readonly kind: 'start' } | { readonly kind: 'resume'; readonly phase: 'before-seal' | 'after-seal'; readonly lock: LockInfo | null } | { readonly kind: 'after-unlock' }

export function useDeleteIdentity(entry: DeleteEntry, onExit?: (s: DeleteState) => void, override?: DeleteState | null): Flow<DeleteState, DeleteEvent> {
  const { t } = useI18n()
  const machine = useMemo(() => deleteMachine(t.deleteIdentity.word), [t])
  return useFlow(
    machine,
    () => (entry.kind === 'start' ? deleteStart() : entry.kind === 'resume' ? deleteResume(entry.phase, entry.lock) : deleteAfterUnlock()),
    'delete',
    onExit,
    override,
  )
}

export function useLegacyReset(resume: boolean, onExit?: (s: LegacyState) => void, override?: LegacyState | null): Flow<LegacyState, LegacyEvent> {
  return useFlow(legacyReset, () => legacyStart(resume), 'legacy', onExit, override)
}

/** What the recovery screen sends on every keystroke: cleaned words, count, and the port's check.
 *  Before the list is complete, a finished word (not the last, which may still be typed) that is
 *  not on the list shows at once. */
export function useWordsEvent(): (text: string) => SetupEvent {
  const port = usePort()
  return (text) => {
    const words = mnemonicWords(text)
    let check: WordsCheck
    if (words.length === 0) check = 'empty'
    else if ([12, 15, 18, 21, 24].includes(words.length)) {
      const r = port.identity.checkMnemonic(words)
      check = r.ok ? 'ok' : r.error.kind === 'refused' && r.error.code === 'mnemonic-checksum' ? 'checksum' : 'unknown-word'
    } else {
      const finished = /\s$/.test(text) ? words : words.slice(0, -1)
      check = finished.every((w) => isKnownWord(port, w)) ? 'incomplete' : 'unknown-word'
    }
    return { type: 'words', text: secret(text), words: check === 'ok' ? (secret(words) as unknown as Secret<Mnemonic>) : null, count: words.length, check }
  }
}

/** A word is on the list when twelve of it pass the word check (then only the checksum can fail). */
function isKnownWord(port: ReturnType<typeof usePort>, word: string): boolean {
  const r = port.identity.checkMnemonic(Array<string>(12).fill(word))
  return r.ok || (r.error.kind === 'refused' && r.error.code === 'mnemonic-checksum')
}

/** iOS screenshot notification while words are shown (ScreenProtectionPort.onCaptured). */
export function useScreenshotNotice(onCaptured: () => void, active: boolean): void {
  const platform = usePlatform()
  const ref = useRef(onCaptured)
  useEffect(() => {
    ref.current = onCaptured
  })
  useEffect(() => (active ? platform.screen.onCaptured(() => ref.current()) : undefined), [platform, active])
}

export function useIdentityCommands() {
  return usePort().identity
}

// ── actions the app shell offers (profile tab) ─────────────────────────────

export interface IdentityActions {
  openProtection(): void
  openDelete(): void
  lock(): void
}

const ActionsCtx = createContext<IdentityActions | null>(null)

export function IdentityActionsProvider({ value, children }: { value: IdentityActions; children: ReactNode }) {
  return createElement(ActionsCtx.Provider, { value }, children)
}

export function useIdentityActions(): IdentityActions {
  const v = useContext(ActionsCtx)
  if (!v) throw new Error('useIdentityActions outside IdentityActionsProvider')
  return v
}
