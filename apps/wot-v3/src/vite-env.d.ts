/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** build target, required (architecture §8.2) */
  readonly VITE_TARGET: 'fdroid' | 'play' | 'appstore' | 'web' | 'harness'
  /** 'true': no live-update code in the bundle and no OTA check (legacy #238; always for play) */
  readonly VITE_DISABLE_LIVE_UPDATE?: string
  /** live-update channel on the update server (fdroid only); unset = live update off */
  readonly VITE_UPDATE_CHANNEL?: string
  readonly VITE_UPDATE_SERVER_URL?: string
  /** C: the DID of the VTI mediator this build carries through (one per build, never per user);
   *  unset = no carrier, documents wait in the holder's custody */
  readonly VITE_MEDIATOR_DID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
