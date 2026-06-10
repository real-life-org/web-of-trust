import { describe, expect, it } from 'vitest'
import { InMemoryMessageIdHistory, MESSAGE_ID_HISTORY_DEFAULT_RETENTION_MS } from '../src/adapters/message-id-history'

const T0 = Date.parse('2026-06-10T12:00:00.000Z')
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString()

const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('InMemoryMessageIdHistory', () => {
  it('checkAndRecord ist atomar: erster Aufruf false, zweiter Aufruf mit gleicher id true (Sync 003 Z.466)', async () => {
    const history = new InMemoryMessageIdHistory()
    expect(await history.checkAndRecord(ID_A, iso(0))).toBe(false)
    expect(await history.checkAndRecord(ID_A, iso(1_000))).toBe(true)
  })

  it('verschiedene ids sind unabhängig', async () => {
    const history = new InMemoryMessageIdHistory()
    expect(await history.checkAndRecord(ID_A, iso(0))).toBe(false)
    expect(await history.checkAndRecord(ID_B, iso(0))).toBe(false)
    expect(await history.checkAndRecord(ID_B, iso(1_000))).toBe(true)
  })

  it('prune entfernt nur Einträge, die strikt älter als der Cutoff sind', async () => {
    const history = new InMemoryMessageIdHistory()
    await history.checkAndRecord(ID_A, iso(0)) // Erstsicht t0
    await history.checkAndRecord(ID_B, iso(2 * 3_600_000)) // Erstsicht t0+2h
    await history.prune(iso(2 * 3_600_000)) // Cutoff t0+2h: A (älter) fällt, B (exakt am Cutoff) bleibt
    expect(await history.checkAndRecord(ID_A, iso(3 * 3_600_000))).toBe(false) // A wieder annehmbar
    expect(await history.checkAndRecord(ID_B, iso(3 * 3_600_000))).toBe(true) // B weiterhin Replay
  })

  it('Retention-Default 24h: Einträge jenseits des Fensters fallen defensiv ohne prune-Aufruf', async () => {
    expect(MESSAGE_ID_HISTORY_DEFAULT_RETENTION_MS).toBe(24 * 60 * 60 * 1000)
    const history = new InMemoryMessageIdHistory()
    await history.checkAndRecord(ID_A, iso(0))
    // Kurz vor Ablauf des Fensters: noch Replay.
    expect(await history.checkAndRecord(ID_A, iso(MESSAGE_ID_HISTORY_DEFAULT_RETENTION_MS - 60_000))).toBe(true)
    // Replays frischen die Erstsicht nicht auf: nach t0+24h ist A verschwunden.
    expect(await history.checkAndRecord(ID_A, iso(MESSAGE_ID_HISTORY_DEFAULT_RETENTION_MS + 60_000))).toBe(false)
  })

  it('konfigurierbare Retention überschreibt den 24h-Default', async () => {
    const history = new InMemoryMessageIdHistory({ retentionMs: 1_000 })
    await history.checkAndRecord(ID_A, iso(0))
    expect(await history.checkAndRecord(ID_A, iso(500))).toBe(true) // im Fenster
    expect(await history.checkAndRecord(ID_B, iso(2_000))).toBe(false) // räumt A mit ab
    expect(await history.checkAndRecord(ID_A, iso(2_000))).toBe(false) // A nicht mehr bekannt
  })

  it('wirft bei ungültigen ISO-Zeitstempeln statt still falsch zu prunen', async () => {
    const history = new InMemoryMessageIdHistory()
    await expect(history.checkAndRecord(ID_A, 'not-a-timestamp')).rejects.toThrow('Invalid ISO timestamp')
    await expect(history.prune('not-a-timestamp')).rejects.toThrow('Invalid ISO timestamp')
    await expect(history.has(ID_A, 'not-a-timestamp')).rejects.toThrow('Invalid ISO timestamp')
  })

  it('has prüft lesend, ohne zu recorden (Sync 003 Z.466 + Z.620-622)', async () => {
    const history = new InMemoryMessageIdHistory()
    expect(await history.has(ID_A, iso(0))).toBe(false)
    // Die lesende Prüfung darf die id nicht verbrennen — sie bleibt unbekannt:
    expect(await history.has(ID_A, iso(1_000))).toBe(false)
    expect(await history.checkAndRecord(ID_A, iso(2_000))).toBe(false)
    expect(await history.has(ID_A, iso(3_000))).toBe(true)
  })

  it('has respektiert das Retention-Fenster', async () => {
    const history = new InMemoryMessageIdHistory({ retentionMs: 1_000 })
    await history.checkAndRecord(ID_A, iso(0))
    expect(await history.has(ID_A, iso(500))).toBe(true)
    expect(await history.has(ID_A, iso(2_000))).toBe(false)
  })
})
