import { useMemo } from 'react'
import { useAdapters, useIdentity } from '../context'
import { useSubscribable } from './useSubscribable'
import type { Subscribable } from '@web_of_trust/core/ports'
import type { Profile, Identity } from '@web_of_trust/core/types'

const EMPTY_PROFILE: Profile = { name: '' }
const EMPTY_IDENTITY: Subscribable<Identity | null> = {
  subscribe: () => () => {},
  getValue: () => null,
}

/**
 * Reactive profile hook — updates automatically when profile data
 * changes from another device or the user edits their profile.
 */
export function useProfile(): Profile {
  const { reactiveStorage } = useAdapters()
  const identity = useLocalIdentity()
  return identity?.profile ?? EMPTY_PROFILE
}

/**
 * Reactive identity hook — returns the full local Identity (did, profile, timestamps)
 * or null if not yet initialized.
 */
export function useLocalIdentity(): Identity | null {
  const { reactiveStorage } = useAdapters()

  const identitySubscribable = useMemo(
    () => reactiveStorage.watchIdentity(),
    [reactiveStorage],
  )

  return useSubscribable(identitySubscribable)
}
