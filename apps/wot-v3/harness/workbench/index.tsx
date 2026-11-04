// Harness page "workbench" (architecture §7.4): the real app on the real library, N phones, on one
// stage with the graph and the wire. URL parameters (on index.html, harness build only):
//
//   ?scenario=workbench                 the page: three people, Jonas met Noah and Noah met Lea
//   &people=jonas,noah,lea,mara,sam     who is seated (2 to 5 of PEOPLE, in this order)
//   &met=jonas-noah,noah-lea            which pairs met before the page opened (default as above)
//   &met=none                           nobody met: everything happens live
//   &carrier=memory | mediator | live   the in-memory carrier (default), the VTI mediator double in
//                                       the page, or a live TSP 1.0 mediator (&mediator=<did>,
//                                       &insecure=1 for a local one), as pair.tsx
//   &lang=en|de &theme=light|dark       the phones' language and theme
//   &tz=<IANA zone>                     the phones' time zone (default America/Los_Angeles)
//   &phone=<id>                         one phone (loaded by the page's own frames)
//
// Everything lives in the page's realm; a phone frame takes its composition from window.parent.

import type { Composition, HarnessPage } from '../../src/app/compose'
import { exposeDevice } from '../device'
import { createWorkbenchWorld, PEOPLE, phoneComposition, type WorkbenchCarrier } from './world'
import { WorkbenchPage } from './WorkbenchPage'
import './workbench.css'

export const DEFAULT_MET: readonly (readonly [string, string])[] = [
  ['jonas', 'noah'],
  ['noah', 'lea'],
]

export function parsePeople(raw: string | null): typeof PEOPLE {
  const ids = (raw ?? 'jonas,noah,lea').split(',').map((s) => s.trim()).filter(Boolean)
  const seated = PEOPLE.filter((p) => ids.includes(p.id))
  return seated.length >= 2 ? seated : PEOPLE.slice(0, 3)
}

export function parseMet(raw: string | null, seated: readonly { id: string }[]): readonly (readonly [string, string])[] {
  if (raw === 'none') return []
  if (!raw) return DEFAULT_MET.filter(([a, b]) => seated.some((p) => p.id === a) && seated.some((p) => p.id === b))
  const ids = new Set(seated.map((p) => p.id))
  return raw
    .split(',')
    .map((pair) => pair.split('-').map((s) => s.trim()))
    .filter((p): p is [string, string] => p.length === 2 && ids.has(p[0] as string) && ids.has(p[1] as string) && p[0] !== p[1])
}

export async function bootWorkbench(url: URL): Promise<Composition | HarnessPage> {
  const p = url.searchParams
  const phone = p.get('phone')
  if (phone) {
    const world = await window.parent.__wotWorkbench
    if (!world) throw new Error('workbench: the phone frame needs the workbench page')
    const d = world.devices.get(phone)
    if (d) exposeDevice(d.platform, world.clock)
    return phoneComposition(world, phone)
  }
  const lang = p.get('lang') === 'de' ? 'de' : 'en'
  const theme = p.get('theme') === 'dark' ? 'dark' : p.get('theme') === 'light' ? 'light' : 'system'
  const live = p.get('carrier') === 'live' ? p.get('mediator') : null
  if (p.get('carrier') === 'live' && !live) throw new Error('workbench: carrier=live needs mediator=<did> of a TSP 1.0 mediator')
  const carrier: WorkbenchCarrier = p.get('carrier') === 'mediator' ? { kind: 'mediator' } : live ? { kind: 'live', did: live, insecure: p.get('insecure') === '1' } : { kind: 'memory' }
  const people = parsePeople(p.get('people'))
  const met = parseMet(p.get('met'), people)
  const tz = p.get('tz')
  const world = createWorkbenchWorld({ people, carrier, lang, theme, met, ...(tz ? { tz } : {}) })
  window.__wotWorkbench = world
  const ready = await world
  if (theme !== 'system') document.documentElement.setAttribute('data-theme', theme)
  return { Root: () => <WorkbenchPage world={ready} query={url.search} /> }
}
