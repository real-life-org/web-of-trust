// The people as their phones show them (Anton 05.11.): each phone's own profile (name, picture) in
// the app's avatar palette, so a node in the graph and the frame of a phone look like that person's
// avatar in the app. Live: a rename or a new picture on a phone changes its node and its frame.
import { useEffect, useState } from 'react'
import { initials, paletteIndex } from '../../src/ui/components/avatar-color'
import type { SeenPerson, WorkbenchWorld } from './world'

export interface WorkbenchAvatar {
  readonly name: string
  readonly image: string | null
  readonly initials: string
  /** the avatar's background, as the app paints it (a CSS colour) */
  readonly bg: string
  /** the initials' colour */
  readonly fg: string
  /** an opaque pastel of the same hue, for the dark stage (frames, chips): one avatar background is
   *  translucent and only reads on the app's white */
  readonly solid: string
}

export function avatarOf(name: string, image: string | null = null): WorkbenchAvatar {
  const n = paletteIndex(name)
  return { name, image, initials: initials(name), bg: `var(--avatar-${n}-bg)`, fg: `var(--avatar-${n}-fg)`, solid: `color-mix(in oklab, var(--avatar-${n}-fg) 32%, white)` }
}

export function useAvatars(world: WorkbenchWorld): ReadonlyMap<string, WorkbenchAvatar> {
  const read = () =>
    new Map(
      world.people.map((p) => {
        const v = world.devices.get(p.id)?.port.stores.profile.get()
        const profile = v?.status === 'ready' ? v.value : null
        return [p.id, avatarOf(profile?.name ?? p.name, profile?.image ?? null)] as const
      }),
    )
  const [avatars, setAvatars] = useState(read)
  useEffect(() => {
    const offs = world.people.map((p) => world.devices.get(p.id)?.port.stores.profile.subscribe(() => setAvatars(read())))
    setAvatars(read())
    return () => offs.forEach((off) => off?.())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world])
  return avatars
}

/** The avatars a camera draws (#517). God's eye: every phone's own profile. A person's camera: their
 *  own profile for themselves, and for everyone else only what their device holds (the contact's name
 *  and picture as received); a phone their device does not hold gets no avatar. */
export function avatarsSeenBy(
  camera: string,
  own: ReadonlyMap<string, WorkbenchAvatar>,
  seen: Readonly<Record<string, Readonly<Record<string, SeenPerson>>>>,
): ReadonlyMap<string, WorkbenchAvatar> {
  if (camera === 'god') return own
  const out = new Map<string, WorkbenchAvatar>()
  const me = own.get(camera)
  if (me) out.set(camera, me)
  for (const [id, p] of Object.entries(seen[camera] ?? {})) if (id !== camera) out.set(id, avatarOf(p.name ?? '?', p.image))
  return out
}
