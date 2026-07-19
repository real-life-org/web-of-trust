/**
 * Black-box-Tests für den InitialCatchUpController — die explizite
 * Lebenszyklus-Abstraktion des Initial-/Reconnect-Catch-ups (vormals implizite
 * Zustandsmaschine im YjsPersonalLogSyncAdapter; P0a Gates 3b–3e).
 *
 * Nur die öffentliche API (request/dispose) und injizierte Deps — keine Casts
 * auf private Felder.
 */
import { describe, it, expect } from 'vitest'
import { InitialCatchUpController, type InitialCatchUpDeps } from '../src/InitialCatchUpController'

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

interface Harness {
  controller: InitialCatchUpController
  calls: { catchUp: number; resend: number; reset: number; errors: string[] }
}

function makeController(overrides: Partial<InitialCatchUpDeps> = {}, backoffMs?: readonly number[]): Harness {
  const calls = { catchUp: 0, resend: 0, reset: 0, errors: [] as string[] }
  const deps: InitialCatchUpDeps = {
    catchUp: async () => { calls.catchUp += 1; return { complete: true } },
    resendPending: async () => { calls.resend += 1 },
    resetForReconnect: () => { calls.reset += 1 },
    isReady: () => true,
    onError: (context) => { calls.errors.push(context) },
    ...overrides,
  }
  // Verkabelt NACH dem Spread, damit Overrides die Zähler mitführen können.
  return { controller: new InitialCatchUpController(deps, backoffMs), calls }
}

describe('InitialCatchUpController', () => {
  it('erfolgreicher Flight: genau ein catchUp + ein resendPending', async () => {
    const { controller, calls } = makeController()
    controller.request(false)
    await wait(20)
    expect(calls.catchUp).toBe(1)
    expect(calls.resend).toBe(1)
    expect(calls.reset).toBe(0)
    controller.dispose()
  })

  it('reconnect-Request ruft resetForReconnect vor dem Flight', async () => {
    const { controller, calls } = makeController()
    controller.request(true)
    await wait(20)
    expect(calls.reset).toBe(1)
    expect(calls.catchUp).toBe(1)
    controller.dispose()
  })

  it('Gate 3b — ein aufgelöster, aber unvollständiger Catch-up (timeout) wird im Backoff erneut versucht', async () => {
    const calls = { n: 0 }
    const { controller } = makeController({
      catchUp: async () => {
        calls.n += 1
        return calls.n === 1 ? { complete: false, incomplete: 'timeout' } : { complete: true }
      },
    })
    controller.request(false)
    for (let i = 0; i < 100 && calls.n < 2; i += 1) await wait(10)
    expect(calls.n).toBeGreaterThanOrEqual(2)
    controller.dispose()
  })

  it('gap-pending/blocked-by-key kurzschleifen NICHT (eigene Recovery-Pfade)', async () => {
    for (const incomplete of ['gap-pending', 'blocked-by-key']) {
      const { controller, calls } = makeController({
        catchUp: async () => { calls.catchUp += 1; return { complete: false, incomplete } },
      })
      controller.request(false)
      await wait(200)
      expect(calls.catchUp, incomplete).toBe(1)
      expect(calls.resend, incomplete).toBe(0)
      controller.dispose()
    }
  })

  it('ein geworfener Fehler wird gemeldet und im Backoff erneut versucht (max 3 Versuche)', async () => {
    const { controller, calls } = makeController({
      catchUp: async () => { calls.catchUp += 1; throw new Error('must call connect() first') },
    })
    controller.request(false)
    for (let i = 0; i < 100 && calls.catchUp < 3; i += 1) await wait(10)
    await wait(50)
    expect(calls.catchUp).toBe(3)
    expect(calls.errors).toEqual(['initial catch-up', 'initial catch-up retry', 'initial catch-up retry'])
    expect(calls.resend).toBe(0)
    controller.dispose()
  })

  it('Single-Flight: ein Request während eines laufenden Flights wird dedupliziert', async () => {
    let release: (() => void) | null = null
    const { controller, calls } = makeController({
      catchUp: async () => {
        calls.catchUp += 1
        await new Promise<void>((resolve) => { release = resolve })
        return { complete: true }
      },
    })
    controller.request(false)
    await wait(5)
    controller.request(false) // dedupliziert, KEIN Rerun gemerkt
    release?.()
    await wait(50)
    expect(calls.catchUp).toBe(1)
    controller.dispose()
  })

  it('ein Reconnect während eines laufenden Flights wird nach dem Settle gedraint', async () => {
    let release: (() => void) | null = null
    const { controller, calls } = makeController({
      catchUp: async () => {
        calls.catchUp += 1
        if (calls.catchUp === 1) await new Promise<void>((resolve) => { release = resolve })
        return { complete: true }
      },
    })
    controller.request(false)
    await wait(5)
    controller.request(true) // Reconnect während Flight → merken
    release?.()
    for (let i = 0; i < 100 && calls.catchUp < 2; i += 1) await wait(10)
    expect(calls.catchUp).toBe(2)
    expect(calls.reset).toBe(1) // der gedrainte Rerun ist ein Reconnect
    controller.dispose()
  })

  it('Gate 3c — dispose() während des Backoffs beendet den Flight (kein pending-Leak)', async () => {
    const { controller, calls } = makeController(
      { catchUp: async () => { calls.catchUp += 1; return { complete: false, incomplete: 'timeout' } } },
      [0, 5000, 5000], // langer Backoff: ohne dispose-Auflösung hinge der Test
    )
    controller.request(false)
    await wait(20) // erster Versuch gelaufen, Flight steckt im Backoff
    expect(calls.catchUp).toBe(1)
    controller.dispose()
    await wait(50)
    expect(calls.catchUp).toBe(1) // kein weiterer Versuch nach dispose
  })

  it('Gate 3d — dispose() detacht einen in catchUp() hängenden Flight; ein NEUER Controller startet frisch', async () => {
    let release: (() => void) | null = null
    let catchUps = 0
    const deps: Partial<InitialCatchUpDeps> = {
      catchUp: async () => {
        catchUps += 1
        if (catchUps === 1) await new Promise<void>((resolve) => { release = resolve })
        return { complete: true }
      },
    }
    const first = makeController(deps)
    first.controller.request(false)
    await wait(5) // hängt IN catchUp()
    first.controller.dispose()
    const second = makeController(deps) // Neustart = neuer Controller (Adapter-Vertrag)
    second.controller.request(false)
    for (let i = 0; i < 100 && catchUps < 2; i += 1) await wait(10)
    expect(catchUps).toBeGreaterThanOrEqual(2)
    release?.()
    second.controller.dispose()
  })

  it('Gate 3e — ein detachter Flight führt nach seiner Freigabe KEIN resendPending() mehr aus', async () => {
    let release: (() => void) | null = null
    let catchUps = 0
    let resends = 0
    const deps: Partial<InitialCatchUpDeps> = {
      catchUp: async () => {
        catchUps += 1
        if (catchUps === 1) await new Promise<void>((resolve) => { release = resolve })
        return { complete: true }
      },
      resendPending: async () => { resends += 1 },
    }
    const first = makeController(deps)
    first.controller.request(false)
    await wait(5)
    first.controller.dispose()
    const second = makeController(deps)
    second.controller.request(false)
    for (let i = 0; i < 100 && resends < 1; i += 1) await wait(10)
    expect(resends).toBe(1) // nur der neue Flight
    release?.() // alter, detachter Flight läuft aus
    await wait(50)
    expect(resends).toBe(1)
    second.controller.dispose()
  })

  it('request() nach dispose() ist ein No-op', async () => {
    const { controller, calls } = makeController()
    controller.dispose()
    controller.request(false)
    controller.request(true)
    await wait(30)
    expect(calls.catchUp).toBe(0)
    expect(calls.reset).toBe(0)
  })

  it('nicht-ready (started=false / disconnected) startet keinen Versuch', async () => {
    const { controller, calls } = makeController({ isReady: () => false })
    controller.request(false)
    await wait(30)
    expect(calls.catchUp).toBe(0)
    controller.dispose()
  })
})
