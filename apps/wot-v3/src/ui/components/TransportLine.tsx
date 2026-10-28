// The transport line (TRANSPORT.md "The VTI mediator"): what the connectivity store says, in one line
// (network, carrier, own documents waiting to be sent, sent and not answered yet), and how one
// contact's relationship is carried or why not. Only what is: no advice, no guess. Only the queue is a
// live region: a change of the connection is not read out on every reconnect.
import type { CarriageMode, Connectivity } from '../../port'
import { useI18n } from '../../i18n'

export function TransportLine({ connectivity: c }: { connectivity: Connectivity }) {
  const { t, f } = useI18n()
  const x = t.transport
  const carrier = { connected: x.connected, connecting: x.connecting, unreachable: x.unreachable, idle: x.idle, 'not-configured': x.none }[c.carrier]
  const connection = [c.network === 'online' ? x.online : c.network === 'offline' ? x.offline : null, carrier].filter((p): p is string => p !== null)
  const queue = [c.queued > 0 ? f(x.queued, { count: String(c.queued) }) : null, c.open > 0 ? f(x.open, { count: String(c.open) }) : null].filter((p): p is string => p !== null)
  return (
    <p className="m-0 flex-none px-5 pb-2 text-xs text-muted-foreground">
      {connection.join(' · ')}
      {queue.length > 0 ? <span aria-hidden="true"> · </span> : null}
      <span role="status" aria-label={x.queue}>
        {queue.map((q, i) => (
          <span key={q}>
            {i > 0 ? <span aria-hidden="true"> · </span> : null}
            {q}
          </span>
        ))}
      </span>
    </p>
  )
}

/** `mode` undefined: the contact is at no carrier of this build; `notConfigured`: the build has none */
export function CarriageLine({ mode, notConfigured = false }: { mode: CarriageMode | undefined; notConfigured?: boolean }) {
  const { t } = useI18n()
  const x = t.transport
  const text = notConfigured
    ? x.notConfigured
    : mode === undefined
      ? null
      : {
          routed: x.routed,
          direct: x.fallback,
          starting: x.connecting,
          'no-hint': x.noHint,
          'hint-unreadable': x.hintUnreadable,
          'ack-state-refused': x.stateRefused,
          'direct-refused': x.directRefused,
          'not-carried': x.notCarried,
        }[mode]
  if (text === null) return null
  return <p className="m-0 text-sm text-pretty">{text}</p>
}
