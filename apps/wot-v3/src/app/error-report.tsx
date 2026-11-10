// The diagnostic entries of this unlock (architecture §2.6): codes, rule references and details the
// adapter recorded, never identifiers, keys or texts. The one place outside the adapter and the
// harness that reads port/diagnostics.ts (.dependency-cruiser.cjs `diagnostics-restricted`). The
// composition installs the adapter's log; the screen lists it under Settings › Development.
import { useEffect, useState } from 'react'
import type { DiagnosticEntry } from '../port/diagnostics'
import { useConnectivity, useFormat, usePlatform } from '../hooks'
import { useI18n } from '../i18n'
import { Button, useToast } from '../ui/primitives'
import { FlowPage } from '../ui/components'

export interface DiagnosticReader {
  list(): readonly DiagnosticEntry[]
  clear(): void
}

let reader: DiagnosticReader | null = null
/** the composition hands the adapter's log over; a build without one shows an empty list */
export const installDiagnostics = (r: DiagnosticReader | null): void => {
  reader = r
}

export function DiagnosticsScreen({ onBack }: { onBack: () => void }) {
  const { t } = useI18n()
  const x = t.diagnostics
  const fmt = useFormat()
  const platform = usePlatform()
  const connectivity = useConnectivity()
  const toast = useToast()
  const [entries, setEntries] = useState<readonly DiagnosticEntry[]>(() => reader?.list() ?? [])
  // the log has no subscription: read again every second while the screen is open
  useEffect(() => {
    const id = setInterval(() => setEntries(reader?.list() ?? []), 1000)
    return () => clearInterval(id)
  }, [])
  const newestFirst = [...entries].reverse()
  /** the report as text: build, time, connectivity, every entry; nothing a diagnostic entry does not hold */
  const report = () =>
    [
      `web-of-trust v3 diagnostics · ${new Date().toISOString()}`,
      `build ${import.meta.env.VITE_TARGET ?? 'unknown'} · carrier ${connectivity.carrier} · network ${connectivity.network} · queued ${connectivity.queued} · open ${connectivity.open}`,
      '',
      ...entries.map((e) => `${new Date(e.at).toISOString()} ${e.code}${e.ref ? ` [${e.ref}]` : ''}${e.detail ? ` ${e.detail}` : ''}`),
    ].join('\n')
  const share = async () => {
    const text = report()
    const name = `wot-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
    let r = await platform.share.shareFile({ name, text, title: x.title })
    if (r === 'unsupported') r = await platform.share.share({ text })
    if (r === 'unsupported') toast.show((await platform.clipboard.copy(text)) ? x.copied : x.shareFailed)
  }
  return (
    <FlowPage title={x.title} onBack={onBack}>
      <p className="m-0 text-sm text-pretty text-muted-foreground">{x.lead}</p>
      {newestFirst.length === 0 ? (
        <p className="m-0 text-sm text-muted-foreground">{x.empty}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="diagnostics">
          {newestFirst.map((e) => (
            <li key={e.id} className="rounded-lg border border-border bg-card px-3 py-2 font-mono text-xs break-all">
              <div className="text-muted-foreground">{fmt.time(e.at)}</div>
              <div>{e.code}{e.ref ? ` · ${e.ref}` : ''}</div>
              {e.detail ? <div className="text-muted-foreground">{e.detail}</div> : null}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void share()}>{x.share}</Button>
        {newestFirst.length > 0 ? (
          <Button variant="outline" onClick={() => { reader?.clear(); setEntries([]) }}>
            {x.clear}
          </Button>
        ) : null}
      </div>
    </FlowPage>
  )
}
