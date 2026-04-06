import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'
import { WotIdentity, type Profile } from '@web_of_trust/core'
import { BiometricService } from '../services/BiometricService'

interface IdentityContextValue {
  identity: WotIdentity | null
  did: string | null
  hasStoredIdentity: boolean | null // null = loading, true/false = checked
  biometricEnrolled: boolean
  initialProfile: Profile | null
  setIdentity: (identity: WotIdentity, did: string, initialProfile?: Profile) => void
  clearIdentity: () => void
  consumeInitialProfile: () => Profile | null
  refreshBiometricStatus: () => Promise<void>
}

const IdentityContext = createContext<IdentityContextValue | null>(null)

export function IdentityProvider({ children }: { children: ReactNode }) {
  const [identity, setIdentityState] = useState<WotIdentity | null>(null)
  const [did, setDid] = useState<string | null>(null)
  const [hasStoredIdentity, setHasStoredIdentity] = useState<boolean | null>(null)
  const [biometricEnrolled, setBiometricEnrolled] = useState(false)
  const [initialProfile, setInitialProfile] = useState<Profile | null>(null)

  const refreshBiometricStatus = async () => {
    const enrolled = await BiometricService.isEnrolled()
    setBiometricEnrolled(enrolled)
  }

  // Check on mount: try session-key auto-unlock, then fall back to checking stored identity
  // IMPORTANT: hasStoredIdentity stays null until the entire check (incl. auto-unlock) is done.
  // AppRoutes uses hasStoredIdentity === null as "still loading" guard to prevent layout flash.
  useEffect(() => {
    const initIdentity = async () => {
      try {
        const tempIdentity = new WotIdentity()
        const hasStored = await tempIdentity.hasStoredIdentity()

        if (hasStored) {
          // Check biometric enrollment status
          refreshBiometricStatus()

          // Try auto-unlock with cached session key
          const hasSession = await tempIdentity.hasActiveSession()
          if (hasSession) {
            try {
              await tempIdentity.unlockFromStorage()
              const newDid = tempIdentity.getDid()
              setIdentityState(tempIdentity)
              setDid(newDid)
              setHasStoredIdentity(true)
              return
            } catch {
              // Session expired or invalid — fall through to passphrase prompt
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

  const setIdentity = (newIdentity: WotIdentity, newDid: string, profile?: Profile) => {
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
