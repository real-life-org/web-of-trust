// The graph tab's data (Anton 04.11.): the contact list and, per contact, the contacts its star names
// (ContactDetail.sharedContacts). One snapshot over several stores of the port: the list, the profile,
// and the detail store of each listed contact; re-read when any of them changes.
import { useEffect, useState } from 'react'
import type { ContactId } from '../port'
import type { GraphInput } from '../screens/graph/graph-model'
import { usePort } from './context'

type Port = ReturnType<typeof usePort>

function read(port: Port): GraphInput | null {
  const list = port.stores.contacts.get()
  const profile = port.stores.profile.get()
  if (list.status !== 'ready') return null
  return {
    me: profile.status === 'ready' ? { name: profile.value.name, image: profile.value.image } : { name: null, image: null },
    contacts: list.value.map((c) => {
      const d = port.stores.contact(c.id).get()
      const shared = d.status === 'ready' && d.value?.sharedContacts ? d.value.sharedContacts.map((x) => x.id) : null
      return { id: c.id, name: c.name, image: c.image, verification: c.verification, trust: c.trust, blocked: c.blocked, shared: shared as readonly ContactId[] | null }
    }),
  }
}

export function useGraphInput(): GraphInput | null {
  const port = usePort()
  const [snap, setSnap] = useState<GraphInput | null>(() => read(port))
  useEffect(() => {
    let details: (() => void)[] = []
    const refresh = () => setSnap(read(port))
    const watchDetails = () => {
      for (const off of details) off()
      const list = port.stores.contacts.get()
      details = list.status === 'ready' ? list.value.map((c) => port.stores.contact(c.id).subscribe(refresh)) : []
    }
    const offList = port.stores.contacts.subscribe(() => {
      watchDetails()
      refresh()
    })
    const offProfile = port.stores.profile.subscribe(refresh)
    watchDetails()
    return () => {
      offList()
      offProfile()
      for (const off of details) off()
    }
  }, [port])
  return snap
}
