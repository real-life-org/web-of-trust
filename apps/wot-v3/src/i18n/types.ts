import type { en } from './en'

type DeepStringify<T> = {
  -readonly [K in keyof T]: T[K] extends string ? string : DeepStringify<T[K]>
}

/** English is the source; every other language must provide every key (architecture §6.4). */
export type Translations = DeepStringify<typeof en>

export type SupportedLanguage = 'en' | 'de'
