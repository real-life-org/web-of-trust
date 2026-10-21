// Harness only: the report screens with a set state need sample messages; they come with the harness
// composition (window), so the app itself carries none (architecture §8.2 store-build check).
import type { MessageItem } from '../port'
import type { ReportState } from '../flows/report'
import { ReportView } from '../screens/report/ReportScreen'

declare global {
  interface Window {
    __wotReportSample?: { readonly name: string; readonly messages: readonly MessageItem[] }
  }
}

const noop = () => {}

export function ReportCatalogView({ state, blocked }: { state: ReportState; blocked: boolean }) {
  const sample = typeof window !== 'undefined' ? window.__wotReportSample : undefined
  return <ReportView state={state} send={noop} name={sample?.name ?? ''} blocked={blocked} messages={sample?.messages ?? []} />
}
