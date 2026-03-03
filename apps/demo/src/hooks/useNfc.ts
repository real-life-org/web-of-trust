import { useState, useEffect } from 'react'
import { Capacitor } from '@capacitor/core'
import { getNfcStatus, requestNfcPermission, type NfcStatus } from '../services/NfcService'

export function useNfc() {
  const [nfcStatus, setNfcStatus] = useState<NfcStatus | null>(null)
  const [permissionRequested, setPermissionRequested] = useState(false)

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) {
      setNfcStatus('web')
      return
    }

    getNfcStatus().then(setNfcStatus)
  }, [])

  useEffect(() => {
    if (nfcStatus === 'available' && !permissionRequested) {
      setPermissionRequested(true)
      requestNfcPermission().catch(console.warn)
    }
  }, [nfcStatus, permissionRequested])

  return { nfcStatus }
}
