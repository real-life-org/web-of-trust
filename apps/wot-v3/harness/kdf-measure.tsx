// harness.html?measure=kdf (harness target only): the unlock cost of the vault on the device it runs
// on, for the acceptance point of architecture §5.2 (measured on the slowest target device). Runs
// scripts/kdf-unlock.mjs, the unlock of scripts/measure-kdf.mjs: PBKDF2-HMAC-SHA-256 600 000 rounds
// plus AES-256-GCM, one warm-up and 10 runs, on random data only. Shows median, min and max large
// and copies the result as text (clipboard port, not sensitive).
import { useEffect, useMemo, useState } from 'react'
import { stats, unlockOnce } from '../scripts/kdf-unlock.mjs'
import { webClipboard, webClock } from '../src/platform/web'

export const KDF_ITERATIONS = 600_000
export const KDF_RUNS = 10

type Phase =
  | { readonly name: 'running'; readonly done: number }
  | { readonly name: 'done'; readonly runs: readonly number[] }
  | { readonly name: 'failed'; readonly reason: string }

const ms = (v: number) => `${Math.round(v)} ms`

export function resultText(runs: readonly number[], env: { userAgent: string; cores: number; at: string }): string {
  const s = stats(runs)
  return [
    'WoT v3 unlock measurement (architecture §5.2)',
    `PBKDF2-HMAC-SHA-256 ${KDF_ITERATIONS} iterations + AES-256-GCM, ${runs.length} runs after 1 warm-up`,
    `median ${ms(s.median)}, min ${ms(s.min)}, max ${ms(s.max)}`,
    `runs: ${runs.map((r) => Math.round(r)).join(', ')} ms`,
    `cores (hardwareConcurrency): ${env.cores}`,
    `user agent: ${env.userAgent}`,
    `at: ${env.at}`,
  ].join('\n')
}

export function KdfMeasure() {
  const [phase, setPhase] = useState<Phase>({ name: 'running', done: 0 })
  const [copied, setCopied] = useState<boolean | null>(null)
  const clipboard = useMemo(() => webClipboard(webClock), [])
  const env = useMemo(() => ({ userAgent: navigator.userAgent, cores: navigator.hardwareConcurrency, at: new Date().toISOString() }), [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // WebCrypto exists only in a secure context: https or localhost (on a phone: adb reverse)
      if (!globalThis.crypto?.subtle) throw new Error('no WebCrypto here: open the page over https or as localhost (see README)')
      await unlockOnce(crypto.subtle, KDF_ITERATIONS) // warm-up
      const runs: number[] = []
      for (let i = 0; i < KDF_RUNS && !cancelled; i++) {
        runs.push(await unlockOnce(crypto.subtle, KDF_ITERATIONS))
        if (!cancelled) setPhase({ name: 'running', done: runs.length })
      }
      if (!cancelled) setPhase({ name: 'done', runs })
    })().catch((e: unknown) => {
      if (!cancelled) setPhase({ name: 'failed', reason: e instanceof Error ? e.message : String(e) })
    })
    return () => {
      cancelled = true
    }
  }, [])

  const text = phase.name === 'done' ? resultText(phase.runs, env) : null
  const s = phase.name === 'done' ? stats(phase.runs) : null
  return (
    <main className="mx-auto flex min-h-dvh max-w-[520px] flex-col gap-5 bg-background p-5 text-foreground">
      <h1 className="m-0 text-xl font-bold">Unlock measurement</h1>
      <p className="m-0 text-sm text-muted-foreground">
        PBKDF2-HMAC-SHA-256 with {KDF_ITERATIONS.toLocaleString('en')} iterations plus AES-256-GCM, {KDF_RUNS} runs after one warm-up. Random data only.
      </p>
      {phase.name === 'running' ? (
        <p role="status" className="m-0 text-lg">
          Measuring… {phase.done} of {KDF_RUNS}
        </p>
      ) : null}
      {phase.name === 'failed' ? (
        <p role="alert" className="m-0 text-lg text-destructive">
          {phase.reason}
        </p>
      ) : null}
      {s && text ? (
        <>
          <section aria-label="Result" data-kdf-result="" className="flex flex-col gap-1">
            <div className="text-5xl font-bold tabular-nums">{ms(s.median)}</div>
            <div className="text-sm text-muted-foreground">median</div>
            <div className="text-lg tabular-nums">
              min {ms(s.min)} · max {ms(s.max)}
            </div>
            <div className="text-sm text-muted-foreground">{env.cores} cores</div>
            <div className="text-xs break-all text-muted-foreground">{env.userAgent}</div>
          </section>
          <button
            type="button"
            onClick={() => void clipboard.copy(text).then(setCopied)}
            className="h-11 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
          >
            Copy result
          </button>
          {copied === null ? null : (
            <p role="status" className="m-0 text-sm">
              {copied ? 'Copied.' : 'Copying failed; select the text below.'}
            </p>
          )}
          <pre className="m-0 text-xs whitespace-pre-wrap select-all">{text}</pre>
        </>
      ) : null}
    </main>
  )
}
