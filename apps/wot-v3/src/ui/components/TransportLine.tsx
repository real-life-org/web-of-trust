// The transport line (TRANSPORT.md "The VTI mediator"): what the connectivity store says, in one line
// (network, carrier, own documents waiting to be sent, sent and not answered yet), and how one
// contact's relationship is carried. Only what is: no advice, no guess.
import type { CarriageMode, Connectivity } from '../../port'
import { useI18n } from '../../i18n'

export function TransportLine({ connectivity: c }: { connectivity: Connectivity }) {
  const { t, f } = useI18n()
  const x = t.transport
  const carrier = { connected: x.connected, connecting: x.connecting, unreachable: x.unreachable, idle: x.idle, 'not-configured': x.none }[c.carrier]
  const parts = [c.network === 'online' ? x.online : c.network === 'offline' ? x.offline : null, carrier, c.queued > 0 ? f(x.queued, { count: String(c.queued) }) : null, c.open > 0 ? f(x.open, { count: String(c.open) }) : null]
  return (
    <p role="status" className="m-0 flex-none px-5 pb-2 text-xs text-muted-foreground">
      {parts.filter((p): p is string => p !== null).join(' · ')}
    </p>
  )
}

export function CarriageLine({ mode }: { mode: CarriageMode | undefined }) {
  const { t } = useI18n()
  const x = t.transport
  if (mode === undefined) return null
  const text = { routed: x.routed, 'egress-session': x.fallback, starting: x.connecting, 'not-carried': x.notCarried }[mode]
  return <p className="m-0 text-sm text-pretty">{text}</p>
}
