/**
 * Type re-exports from @web_of_trust/adapter-automerge.
 *
 * Runtime functions must be dynamically imported:
 *   const { initPersonalDoc } = await import('@web_of_trust/adapter-automerge')
 *
 * This keeps Automerge WASM out of the default (Yjs) bundle.
 */
export type {
  PersonalDoc,
  ProfileDoc,
  ContactDoc,
  AttestationDoc,
  AttestationMetadataDoc,
  OutboxEntryDoc,
  SpaceMetadataDoc,
  GroupKeyDoc,
} from '@web_of_trust/adapter-automerge'
