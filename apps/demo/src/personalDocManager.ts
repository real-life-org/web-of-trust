/**
 * Type re-exports from @real-life/adapter-automerge.
 *
 * Runtime functions must be dynamically imported:
 *   const { initPersonalDoc } = await import('@real-life/adapter-automerge')
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
} from '@real-life/adapter-automerge'
