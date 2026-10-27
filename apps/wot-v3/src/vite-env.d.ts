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
  /** 'true' in a web build with a mediator: the interop probe in the developer area (TRANSPORT.md
   *  "Interop probe"); every other target ignores it, and no store build carries the probe's module */
  readonly VITE_INTEROP_PROBE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
