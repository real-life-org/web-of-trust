/**
 * Type re-exports from @web.of.trust/adapter-automerge.
 *
 * Runtime functions must be dynamically imported:
 *   const { initPersonalDoc } = await import('@web.of.trust/adapter-automerge')
 *
 * This keeps Automerge WASM out of the default (Yjs) bundle.
 */
export type {
  PersonalDoc,
  ProfileDoc,
  ContactDoc,
  VerificationDoc,
  AttestationDoc,
  AttestationMetadataDoc,
  OutboxEntryDoc,
  SpaceMetadataDoc,
  GroupKeyDoc,
} from '@web.of.trust/adapter-automerge'
