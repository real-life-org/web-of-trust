// Local notifications (architecture §5 NotificationPort, N12): @capacitor/local-notifications, only
// while the process lives, no push. Each notification carries its namespace in `extra.ns`; the
// numeric platform IDs are kept per namespace in prefs under the namespace's own prefix
// (`<ns>:notify.ids`, removed by wipeNamespace with the other prefs of ns) and in memory, so a delete
// finds them again where the platform drops `extra` of delivered ones. Never throws: failures come
// back as `ok: false` with what remained.

import { LocalNotifications } from '@capacitor/local-notifications'
import type { NotificationPort, PrefsPort } from '../ports'

const IDS = ':notify.ids'
const SEQ = 'notify.seq'

/** The plugin as far as the port uses it (a seam for tests). */
export type LocalNotificationsApi = Pick<
  typeof LocalNotifications,
  'checkPermissions' | 'requestPermissions' | 'schedule' | 'getPending' | 'getDeliveredNotifications' | 'cancel' | 'removeDeliveredNotifications' | 'addListener'
>

type Entry = { readonly id: number; readonly extra?: unknown }

const nsOf = (e: Entry, table: Map<number, string>): string | null => {
  const x = e.extra as { ns?: unknown } | undefined
  return typeof x?.ns === 'string' ? x.ns : (table.get(e.id) ?? null)
}

export function capacitorNotifications(prefs: PrefsPort, api: LocalNotificationsApi = LocalNotifications): NotificationPort {
  const read = (key: string): Record<string, number> => {
    try {
      const v = JSON.parse(prefs.get(key) ?? '{}') as unknown
      return v && typeof v === 'object' ? (v as Record<string, number>) : {}
    } catch {
      return {}
    }
  }
  /** what this process scheduled: survives the removal of the prefs of ns until the cleanup ran */
  const seen = new Map<number, string>()
  /** numeric ID → namespace, from every table in prefs and from memory */
  const table = (): Map<number, string> => {
    const m = new Map(seen)
    for (const k of prefs.keys()) if (k.endsWith(IDS)) for (const id of Object.values(read(k))) m.set(id, k.slice(0, -IDS.length))
    return m
  }
  // loaded at start, before any wipe: wipeNamespace removes the prefs of ns before it cleans the
  // notifications, and the IDs must still name their namespace then (also after a restart)
  for (const [id, ns] of table()) seen.set(id, ns)
  const numericId = (ns: string, local: string): number => {
    const ids = read(ns + IDS)
    const known = ids[local]
    if (typeof known === 'number') return known
    // 31-bit positive IDs (Android int), counted up across namespaces
    const next = ((Number(prefs.get(SEQ)) || 0) % 0x7ffffffe) + 1
    prefs.set(SEQ, String(next))
    prefs.set(ns + IDS, JSON.stringify({ ...ids, [local]: next }))
    return next
  }
  const pending = async (): Promise<Entry[]> => (await api.getPending()).notifications as Entry[]
  const delivered = async (): Promise<Entry[]> => (await api.getDeliveredNotifications()).notifications as Entry[]
  const ids = (es: readonly Entry[]) => es.map((e) => String(e.id))

  const port: NotificationPort = {
    async permission() {
      try {
        const { display } = await api.checkPermissions()
        return display === 'granted' ? 'granted' : display === 'denied' ? 'denied' : 'prompt'
      } catch {
        return 'denied'
      }
    },
    async request() {
      try {
        return (await api.requestPermissions()).display === 'granted' ? 'granted' : 'denied'
      } catch {
        return 'denied'
      }
    },
    async notify({ ns, id, title, body, route }) {
      try {
        const n = numericId(ns, id)
        seen.set(n, ns)
        await api.schedule({ notifications: [{ id: n, title, body, extra: { ns, id: `${ns}:${id}`, route } }] })
      } catch {
        // a notification that could not be shown is not an error of the app
      }
    },
    onOpen(cb) {
      let removed = false
      let handle: { remove: () => Promise<void> } | null = null
      api
        .addListener('localNotificationActionPerformed', (a) => {
          const route = (a.notification.extra as { route?: unknown } | undefined)?.route
          if (typeof route === 'string') cb(route)
        })
        .then(
          (h) => {
            if (removed) void h.remove().catch(() => undefined)
            else handle = h
          },
          () => undefined,
        )
      return () => {
        removed = true
        void handle?.remove().catch(() => undefined)
      }
    },
    async list() {
      const t = table()
      const out: { id: string; ns: string | null; state: 'scheduled' | 'delivered' }[] = []
      try {
        for (const e of await pending()) out.push({ id: String(e.id), ns: nsOf(e, t), state: 'scheduled' })
      } catch {
        // reported by verifyNone as not verifiable
      }
      try {
        for (const e of await delivered()) out.push({ id: String(e.id), ns: nsOf(e, t), state: 'delivered' })
      } catch {
        // as above
      }
      return out
    },
    async cancelNamespace(ns) {
      try {
        const t = table()
        const mine = (await pending()).filter((e) => nsOf(e, t) === ns)
        if (mine.length > 0) await api.cancel({ notifications: mine.map((e) => ({ id: e.id })) })
        const left = (await pending()).filter((e) => nsOf(e, t) === ns)
        return { ok: left.length === 0, remaining: ids(left) }
      } catch {
        return { ok: false, remaining: [] }
      }
    },
    async removeDelivered(ns) {
      try {
        const t = table()
        const match = (e: Entry) => ns === 'all' || nsOf(e, t) === ns
        const all = (await api.getDeliveredNotifications()).notifications
        const mine = all.filter((e) => match(e as Entry))
        if (mine.length > 0) await api.removeDeliveredNotifications({ notifications: mine })
        const left = (await delivered()).filter(match)
        // the ID table of a namespace goes once nothing of it is left
        if (left.length === 0 && (ns === 'all' || (await pending()).every((e) => nsOf(e, t) !== ns))) {
          for (const k of prefs.keys()) if (k.endsWith(IDS) && (ns === 'all' || k === ns + IDS)) prefs.remove(k)
          for (const [id, of] of [...seen]) if (ns === 'all' || of === ns) seen.delete(id)
        }
        return { ok: left.length === 0, remaining: ids(left) }
      } catch {
        return { ok: false, remaining: [] }
      }
    },
    async verifyNone(ns) {
      try {
        const t = table()
        const all = [...(await pending()), ...(await delivered())]
        // a notification whose namespace cannot be told may be of ns: never verified as gone
        return all.every((e) => ns !== 'all' && nsOf(e, t) !== ns && nsOf(e, t) !== null)
      } catch {
        return false
      }
    },
  }
  return port
}
