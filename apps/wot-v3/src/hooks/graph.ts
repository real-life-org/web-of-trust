// The graph tab's data (Anton 04.11.): the contact list and, per contact, the contacts its star names
// (ContactDetail.sharedContacts). One snapshot over several stores of the port: the list, the profile,
// the detail store of each listed contact, the groups and each group's details; re-read when any of
// them changes.
import { useEffect, useState } from 'react'
import type { ContactId } from '../port'
import type { GraphInput } from './graph-model'
import { usePort } from './context'

type Port = ReturnType<typeof usePort>

/** the graph's input as the port's stores hold it now */
export function graphInputOf(port: Port): GraphInput | null {
  const list = port.stores.contacts.get()
  const profile = port.stores.profile.get()
  if (list.status !== 'ready') return null
  // who is in which group apart from the group's own log: a contact's group star says the groups it
  // shares with this device (ContactDetail.sharedGroups). Which member of the group the contact is the
  // star does not say; that the contact is one of them it does.
  const starred = new Map<string, ContactId[]>()
  for (const c of list.value) {
    const d = port.stores.contact(c.id).get()
    for (const g of (d.status === 'ready' && d.value?.sharedGroups) || []) starred.set(g, [...(starred.get(g) ?? []), c.id])
  }
  return {
    me: profile.status === 'ready' ? { name: profile.value.name, image: profile.value.image } : { name: null, image: null },
    contacts: list.value.map((c) => {
      const d = port.stores.contact(c.id).get()
      const shared = d.status === 'ready' && d.value?.sharedContacts ? d.value.sharedContacts.map((x) => x.id) : null
      return { id: c.id, name: c.name, image: c.image, verification: c.verification, trust: c.trust, blocked: c.blocked, shared: shared as readonly ContactId[] | null }
    }),
    groups: groupsOf(port).map((g) => {
      const d = port.stores.group(g.id).get()
      const members = d.status === 'ready' && d.value ? d.value.visibleMembers : null
      // without the details the membership decides: a member is in the log, one who is joining is not yet
      const selfListed = members ? members.some((m) => m.self) : g.membership === 'member'
      return { id: g.id, name: g.name, joining: g.membership === 'joining', knownMembers: g.knownMembers, selfListed, contacts: [...(members ?? []).flatMap((m) => (!m.self && m.contactId ? [m.contactId] : [])), ...(starred.get(g.id) ?? [])] }
    }),
  }
}

/** the groups the device is in or is joining: one it left, or never got into, is no part of the network */
function groupsOf(port: Port) {
  const list = port.stores.groups.get()
  return list.status === 'ready' ? list.value.filter((g) => g.membership === 'member' || g.membership === 'joining') : []
}

export function useGraphInput(): GraphInput | null {
  const port = usePort()
  const [snap, setSnap] = useState<GraphInput | null>(() => graphInputOf(port))
  useEffect(() => {
    let details: (() => void)[] = []
    const refresh = () => setSnap(graphInputOf(port))
    const watchDetails = () => {
      for (const off of details) off()
      const list = port.stores.contacts.get()
      details = [...(list.status === 'ready' ? list.value.map((c) => port.stores.contact(c.id).subscribe(refresh)) : []), ...groupsOf(port).map((g) => port.stores.group(g.id).subscribe(refresh))]
    }
    const offList = port.stores.contacts.subscribe(() => {
      watchDetails()
      refresh()
    })
    const offGroups = port.stores.groups.subscribe(() => {
      watchDetails()
      refresh()
    })
    const offProfile = port.stores.profile.subscribe(refresh)
    watchDetails()
    return () => {
      offList()
      offGroups()
      offProfile()
      for (const off of details) off()
    }
  }, [port])
  return snap
}
