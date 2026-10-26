// Effect runner of the flows (architecture §4.1): holds a machine state, applies events, executes
// the effects against port and platform and feeds each outcome back as a `result` event. Results of
// an older run are dropped by the machine itself. Plain TypeScript (no React): the identity hooks
// wrap it with useSyncExternalStore, the transition tests drive it directly.
//
// The runner also owns the screen protection of the flow (§5): 'sensitive' while the machine says
// so, 'normal' when it says not and when the runner is disposed (cancel of the machine).

import type { AppPort, BiometricPromptText, Mnemonic, Result, Secret } from '../port'
import type { Platform } from '../platform/ports'
import type { DeleteEffect } from '../flows/delete'
import type { LegacyEffect } from '../flows/legacy-reset'
import type { EffectResult, Effect, Machine, ResultEvent, Step } from '../flows/machine'
import type { ProtectionEffect } from '../flows/protection'
import type { SetupEffect } from '../flows/setup'
import type { UnlockEffect } from '../flows/unlock'
import { formatMnemonicForCopy } from '../lib/mnemonic-format'

export interface FlowRunner<S, E> {
  get(): S
  subscribe(cb: () => void): () => void
  send(event: E): void
  /** rows taken so far (transition tests check table coverage with it) */
  readonly rows: readonly string[]
  /** resolves when no effect is running */
  idle(): Promise<void>
  dispose(): void
}

export function createFlowRunner<S extends { readonly name: string; readonly run: number }, E, F extends Effect>(
  machine: Machine<S, E, F>,
  start: Step<S, F> | S,
  exec: (effect: F) => Promise<EffectResult>,
  platform: Pick<Platform, 'screen'> | null = null,
): FlowRunner<S, E> {
  const first: Step<S, F> = 'state' in start && 'effects' in start ? start : { state: start as S, effects: [], row: null }
  let state = first.state
  let disposed = false
  let running = 0
  let waiters: (() => void)[] = []
  const rows: string[] = first.row ? [first.row] : []
  const listeners = new Set<() => void>()
  let level: 'normal' | 'sensitive' = 'normal'

  const protect = () => {
    const next = !disposed && machine.sensitive(state) ? 'sensitive' : 'normal'
    if (next !== level) {
      level = next
      platform?.screen.set(next)
    }
  }
  const notify = () => {
    protect()
    for (const l of [...listeners]) l()
  }
  const settle = () => {
    if (running === 0) {
      const w = waiters
      waiters = []
      for (const r of w) r()
    }
  }

  const run = (effects: readonly F[]) => {
    for (const effect of effects) {
      running++
      exec(effect)
        // the flows carry passphrases and words: an unexpected throw enters the machine as the fixed
        // code 'bug' without its text, which could hold a revealed value (architecture §5)
        .catch((): EffectResult => ({ ok: false, code: 'bug' }))
        .then((result) => {
          if (!disposed) apply({ type: 'result', id: effect.id, run: effect.run, result })
        })
        .finally(() => {
          running--
          settle()
        })
    }
  }

  const apply = (event: E | ResultEvent) => {
    const step = machine.transition(state, event)
    if (step.row) rows.push(step.row)
    if (step.state !== state) {
      state = step.state
      notify()
    }
    run(step.effects)
  }

  protect()
  // The first effects start one microtask later and only if the runner is still alive: React's
  // StrictMode mounts, disposes and mounts again within one commit, and a biometric prompt must
  // not open twice.
  if (first.effects.length > 0) {
    running++
    queueMicrotask(() => {
      running--
      if (!disposed) run(first.effects)
      settle()
    })
  }

  return {
    get: () => state,
    subscribe(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    send: (event) => {
      if (!disposed) apply(event)
    },
    rows,
    idle: async () => {
      // effects may chain: wait until a microtask passes with nothing running
      for (;;) {
        if (running === 0) {
          await Promise.resolve()
          if (running === 0) return
        }
        await new Promise<void>((r) => waiters.push(r))
      }
    },
    dispose() {
      disposed = true
      protect()
      listeners.clear()
    },
  }
}

// ── identity effects → port ─────────────────────────────────────────────────

const fromResult = (r: Result<unknown>): EffectResult => {
  if (r.ok) return { ok: true, value: r.value }
  // the cause travels to the screen, which names it (an earlier or newer version, an unknown format, damage)
  if (r.error.kind === 'state-unreadable') return { ok: false, code: 'state-unreadable', value: { cause: r.error.cause } }
  return { ok: false, code: 'code' in r.error ? String(r.error.code) : r.error.kind }
}

/** Localized texts the effects need (biometric system prompts). */
export interface EffectTexts {
  readonly unlockPrompt: BiometricPromptText
  readonly enrollPrompt: BiometricPromptText
}

/** Three distinct positions of the word list, ascending, from the entropy port (verifyWords). */
export function pickPositions(platform: Pick<Platform, 'entropy'>, length: number, n = 3): number[] {
  const out = new Set<number>()
  while (out.size < Math.min(n, length)) {
    const b = platform.entropy.bytes(2)
    const v = ((b[0] ?? 0) << 8) | (b[1] ?? 0)
    // rejection sampling: no modulo bias (legacy c49e0a90)
    const limit = 65536 - (65536 % length)
    if (v < limit) out.add(v % length)
  }
  return [...out].sort((a, b) => a - b)
}

export function identityExecutor(port: AppPort, platform: Pick<Platform, 'entropy' | 'clipboard'>, texts: EffectTexts) {
  const id = port.identity
  const setup = async (e: SetupEffect): Promise<EffectResult> => {
    switch (e.id) {
      case 'onb.gen': {
        const r = await id.generate()
        if (!r.ok) return fromResult(r)
        return { ok: true, value: { words: r.value, positions: pickPositions(platform, r.value.reveal().length) } }
      }
      case 'onb.copy':
        return { ok: await platform.clipboard.copy(formatMnemonicForCopy(e.words.reveal()), { sensitive: true }) }
      case 'onb.probe':
      case 'rec.probe':
        return { ok: true, value: await id.biometricAvailability() }
      case 'onb.marker':
      case 'rec.marker':
        return fromResult(await id.setup.reserve(e.flow, e.mode))
      case 'onb.ks':
      case 'rec.ks': {
        const r = e.phase === 'before' ? await id.setup.keystoreFirst(e.ns, texts.enrollPrompt) : await id.setup.keystoreAfter(e.ns, texts.enrollPrompt)
        return r.ok ? { ok: true } : { ok: false, code: r.code }
      }
      case 'onb.ksUndo':
      case 'rec.ksUndo':
        return { ok: true, value: await id.setup.undoKeystore(e.ns) }
      case 'onb.vaultUndo':
      case 'rec.vaultUndo':
        return { ok: true, value: await id.setup.undoVault(e.ns) }
      case 'onb.vault':
      case 'rec.vault': {
        const protection =
          e.mode === 'biometric-only' || !e.passphrase ? ({ mode: 'biometric-only' } as const) : { mode: e.mode, passphrase: e.passphrase }
        return fromResult(await id.setup.writeVault(e.ns, { mnemonic: e.words as Secret<Mnemonic>, protection, profile: e.profile, termsVersion: e.termsVersion }))
      }
      case 'onb.bioUnusable':
      case 'rec.bioUnusable':
        await id.setup.markBioUnusable(e.ns)
        return { ok: true }
      case 'onb.init':
      case 'rec.init':
        return fromResult(await id.setup.initHolder(e.ns))
      case 'onb.activate':
        return fromResult(await id.setup.activate(e.ns))
      case 'rec.switch':
        return fromResult(await id.setup.switchTo(e.ns))
      case 'rec.wipeOld':
        return fromResult(await id.setup.wipeOld())
      case 'rec.verifyOld': {
        const r = await id.setup.verifyOld()
        return r.ok ? { ok: true } : { ok: false, value: { survivors: r.survivors } }
      }
      case 'rec.done':
        return fromResult(await id.setup.finishRestore())
    }
  }

  const unlock = async (e: UnlockEffect): Promise<EffectResult> => {
    switch (e.id) {
      case 'unl.bio': {
        const r = await id.unlock.biometric(texts.unlockPrompt)
        return r.ok ? { ok: true } : { ok: false, code: r.code }
      }
      case 'unl.vault':
        return fromResult(await id.unlock.passphrase(e.passphrase))
      case 'unl.bioUnusable':
        await id.unlock.markBioUnusable()
        return { ok: true }
      case 'unl.holder':
        return fromResult(await id.unlock.open())
      case 'unl.reprotect':
        return fromResult(await id.unlock.reprotect())
      case 'unl.ksRestore': {
        const r = await id.unlock.restoreKeystore(texts.enrollPrompt)
        return r.ok ? { ok: true } : { ok: false, code: r.code }
      }
      case 'unl.offerEnable': {
        const r = await id.unlock.enableBiometric(texts.enrollPrompt)
        return r.ok ? { ok: true } : { ok: false, code: r.code }
      }
      case 'unl.offerDismiss':
        await id.unlock.dismissBiometricOffer()
        return { ok: true }
      case 'onb.init':
        return fromResult(await id.setup.initHolder(null))
      case 'onb.activate':
        return fromResult(await id.setup.activate(null))
    }
  }

  const protection = async (e: ProtectionEffect): Promise<EffectResult> => {
    switch (e.id) {
      case 'prt.prove':
        return fromResult(await id.protection.prove(e.passphrase ? { passphrase: e.passphrase } : { biometric: texts.unlockPrompt }))
      case 'prt.ks': {
        const r = await id.protection.keystoreStore(texts.enrollPrompt)
        return r.ok ? { ok: true } : { ok: false, code: r.code }
      }
      case 'prt.head':
        return fromResult(await id.protection.setHead(e.mode))
      case 'prt.rewrap':
        return fromResult(await id.protection.rewrap(e.passphrase))
      case 'prt.ksRemove':
        return fromResult(await id.protection.keystoreRemove())
    }
  }

  const del = async (e: DeleteEffect): Promise<EffectResult> => {
    switch (e.id) {
      case 'del.quiesce':
        return fromResult(await id.delete.quiesce())
      case 'del.dereg':
        return { ok: true, value: await id.delete.deregister(e.mode) }
      case 'del.seal':
        return fromResult(await id.delete.seal())
      case 'del.close':
        return fromResult(await id.delete.close())
      case 'del.wipe':
        return fromResult(await id.delete.wipe())
      case 'del.verify': {
        const r = await id.delete.verify()
        return r.ok ? { ok: true } : { ok: false, value: { survivors: r.survivors } }
      }
      case 'del.done':
        return { ok: true, value: await id.delete.finish() }
    }
  }

  const legacy = async (e: LegacyEffect): Promise<EffectResult> => {
    switch (e.id) {
      case 'leg.wipe':
        return fromResult(await id.legacy.wipe())
      case 'leg.verify': {
        const r = await id.legacy.verify()
        return r.ok ? { ok: true } : { ok: false, value: { survivors: r.survivors } }
      }
      case 'leg.mark':
        await id.legacy.mark()
        return { ok: true }
    }
  }

  return { setup, unlock, protection, delete: del, legacy }
}

export type IdentityExecutor = ReturnType<typeof identityExecutor>
