// Report and block (architecture §4.1 `useReport`, paper §6): the report machine with its effect
// runner (block intent, mail draft or share sheet, clipboard), the mail text from the conversation,
// and the silent block / unblock of the contact detail.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { AppPort, ContactId, MessageItem, Result } from '../port'
import type { Platform } from '../platform/ports'
import type { EffectResult } from '../flows/machine'
import { reportMachine, reportStart, type ReportEffect, type ReportEvent, type ReportState } from '../flows/report'
import { MAX_REPORT_MESSAGES, reportMail, transcript, type ReportMail } from '../lib/report'
import { useI18n } from '../i18n'
import { createFlowRunner, type FlowRunner } from './flow-runner'
import { usePlatform, usePort } from './context'
import { useFormat } from './useFormat'

export type { ReportState, ReportEvent } from '../flows/report'
export { MAX_REPORT_MESSAGES, REPORT_ADDRESS } from '../lib/report'

const fromResult = (r: Result<unknown>): EffectResult =>
  r.ok ? { ok: true, value: r.value } : { ok: false, code: 'code' in r.error ? String(r.error.code) : r.error.kind }

export function reportExecutor(port: AppPort, platform: Pick<Platform, 'mail' | 'share' | 'clipboard'>) {
  return async (e: ReportEffect): Promise<EffectResult> => {
    switch (e.id) {
      case 'rep.block':
        return fromResult(await port.trust.block({ kind: 'contact', contactId: e.contactId }).done)
      case 'rep.compose': {
        const m = e.mail
        if (m.file) {
          // a long transcript: the share sheet with the file and the standard text (paper §6 step 4)
          const r = await platform.share.shareFile({ name: m.file.name, text: m.file.text, title: m.subject, body: m.body })
          return r === 'shared' ? { ok: true } : { ok: false, code: r }
        }
        const r = await platform.mail.compose({ to: m.to, subject: m.subject, body: m.body })
        return r === 'opened' ? { ok: true } : { ok: false, code: r }
      }
      case 'rep.copy':
        return { ok: await platform.clipboard.copy(e.text), value: e.what }
    }
  }
}

/** The mail for the selected messages, in the app language and the device's time zone. */
export function useReportMail(name: string, messages: readonly MessageItem[]): (selected: readonly string[]) => ReportMail {
  const { t, f } = useI18n()
  const fmt = useFormat()
  const platform = usePlatform()
  return useCallback(
    (selected) => {
      const r = t.report
      const chosen = messages.filter((m) => selected.includes(m.id))
      const time = (at: number) => `${fmt.date(at)} ${fmt.time(at)}`
      const text = transcript(
        chosen.map((m) => ({
          mine: m.author.kind === 'self',
          author: m.author.kind === 'self' ? r.me : name,
          sentAt: m.sentAt ?? m.at,
          receivedAt: m.receivedAt ?? null,
          text: m.text,
        })),
        time,
        { sent: (x) => f(r.sentAt, { time: x }), received: (x) => f(r.receivedAt, { time: x }), heading: f(r.heading, { name, zone: platform.clock.timeZone() }) },
      )
      return reportMail({ subject: r.subject, intro: r.intro, introAttached: r.introAttached, transcript: text, fileName: r.fileName })
    },
    [t, f, fmt, platform, name, messages],
  )
}

export interface ReportFlow {
  readonly state: ReportState
  readonly send: (e: ReportEvent) => void
}

export function useReport(contactId: ContactId, preselected: readonly string[], onExit: (s: Extract<ReportState, { name: 'exit' }>) => void, override?: ReportState | null): ReportFlow {
  const port = usePort()
  const platform = usePlatform()
  const machine = useMemo(() => reportMachine(contactId), [contactId])
  const [first] = useState(() => reportStart(preselected.slice(-MAX_REPORT_MESSAGES)))
  const [runner, setRunner] = useState<FlowRunner<ReportState, ReportEvent> | null>(null)
  useEffect(() => {
    if (override) return
    const r = createFlowRunner(machine, first, reportExecutor(port, platform), platform)
    setRunner(r)
    return () => r.dispose()
    // the runner lives as long as the screen that started the flow
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const subscribe = runner ? runner.subscribe : noSubscribe
  const get = runner ? runner.get : () => override ?? first
  const state = useSyncExternalStore(subscribe, get, get)
  const exitRef = useRef(onExit)
  useEffect(() => {
    exitRef.current = onExit
  })
  useEffect(() => {
    if (state.name === 'exit') exitRef.current(state)
  }, [state])
  return { state, send: runner ? runner.send : noop }
}

/** Silent block and unblock (paper §7.1, §7.6): one intent each, block plus pause. */
export function useBlock(contactId: ContactId): { readonly busy: boolean; block(): Promise<Result>; unblock(): Promise<Result> } {
  const port = usePort()
  const [busy, setBusy] = useState(false)
  const run = useCallback(async (fn: () => Promise<Result>) => {
    setBusy(true)
    try {
      return await fn()
    } finally {
      setBusy(false)
    }
  }, [])
  return {
    busy,
    block: () => run(() => port.trust.block({ kind: 'contact', contactId }).done),
    unblock: () => run(() => port.trust.unblock({ kind: 'contact', contactId }).done),
  }
}

const noSubscribe = () => () => {}
const noop = () => {}
