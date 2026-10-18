/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** build target, required (architecture §8.2) */
  readonly VITE_TARGET: 'fdroid' | 'play' | 'appstore' | 'web' | 'harness'
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
