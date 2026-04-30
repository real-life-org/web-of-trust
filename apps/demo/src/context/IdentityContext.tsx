import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'
import type { IdentitySession, Profile } from '@web_of_trust/core'
import { BiometricService } from '../services/BiometricService'
import { createIdentityWorkflow } from '../services/identityWorkflow'

interface IdentityContextValue {
  identity: IdentitySession | null
  did: string | null
  hasStoredIdentity: boolean | null // null = loading, true/false = checked
  biometricEnrolled: boolean
  initialProfile: Profile | null
  setIdentity: (identity: IdentitySession, did: string, initialProfile?: Profile) => void
  clearIdentity: () => void
  consumeInitialProfile: () => Profile | null
  refreshBiometricStatus: () => Promise<void>
}

const IdentityContext = createContext<IdentityContextValue | null>(null)

export function IdentityProvider({ children }: { children: ReactNode }) {
  const [identity, setIdentityState] = useState<IdentitySession | null>(null)
  const [did, setDid] = useState<string | null>(null)
  const [hasStoredIdentity, setHasStoredIdentity] = useState<boolean | null>(null)
  const [biometricEnrolled, setBiometricEnrolled] = useState(false)
  const [initialProfile, setInitialProfile] = useState<Profile | null>(null)

  const refreshBiometricStatus = async () => {
    const enrolled = await BiometricService.isEnrolled()
    setBiometricEnrolled(enrolled)
  }

  // Check on mount: detect whether a persisted identity exists before rendering routes.
  // IMPORTANT: hasStoredIdentity stays null until the entire check (incl. auto-unlock) is done.
  // AppRoutes uses hasStoredIdentity === null as "still loading" guard to prevent layout flash.
  useEffect(() => {
    const initIdentity = async () => {
      try {
        const workflow = createIdentityWorkflow()
        const hasStored = await workflow.hasStoredIdentity()

        if (hasStored) {
          await refreshBiometricStatus()

          if (await workflow.hasActiveSession()) {
            try {
              const { identity } = await workflow.unlockStoredIdentity()
              setIdentityState(identity)
              setDid(identity.getDid())
              setHasStoredIdentity(true)
              return
            } catch (error) {
              console.warn('Session auto-unlock failed:', error)
            }
          }
        }

        setHasStoredIdentity(hasStored)
      } catch (error) {
        console.error('Error checking stored identity:', error)
        setHasStoredIdentity(false)
      }
    }

    initIdentity()
  }, [])

  const setIdentity = (newIdentity: IdentitySession, newDid: string, profile?: Profile) => {
    setIdentityState(newIdentity)
    setDid(newDid)
    setHasStoredIdentity(true)
    if (profile) setInitialProfile(profile)
  }

  const clearIdentity = () => {
    setIdentityState(null)
    setDid(null)
    setHasStoredIdentity(false)
    setInitialProfile(null)
  }

  const consumeInitialProfile = (): Profile | null => {
    const profile = initialProfile
    setInitialProfile(null)
    return profile
  }

  return (
    <IdentityContext.Provider
      value={{
        identity,
        did,
        hasStoredIdentity,
        biometricEnrolled,
        initialProfile,
        setIdentity,
        clearIdentity,
        consumeInitialProfile,
        refreshBiometricStatus,
      }}
    >
      {children}
    </IdentityContext.Provider>
  )
}

export function useIdentity(): IdentityContextValue {
  const context = useContext(IdentityContext)
  if (!context) {
    throw new Error('useIdentity must be used within an IdentityProvider')
  }
  return context
}
