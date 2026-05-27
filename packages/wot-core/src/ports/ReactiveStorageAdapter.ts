import type { Subscribable } from './Subscribable'
import type { Identity } from '../types/identity'
import type { Contact } from '../types/contact'
import type { Verification } from '../types/verification'
import type { Attestation } from '../types/attestation'

/**
 * Reactive extension for storage backends that support live queries.
 *
 * Backends with native reactivity (Evolu, p2panda, Jazz) implement this.
 * Backends without (REST, CLI) implement only StorageAdapter.
 *
 * A single adapter class can implement both:
 *   class EvoluAdapter implements StorageAdapter, ReactiveStorageAdapter
 */
export interface ReactiveStorageAdapter {
  watchIdentity(): Subscribable<Identity | null>
  watchContacts(): Subscribable<Contact[]>
  watchReceivedVerifications(): Subscribable<Verification[]>  // to=me
  watchAllVerifications(): Subscribable<Verification[]>      // from=me OR to=me
  watchAllAttestations(): Subscribable<Attestation[]>        // from=me OR to=me
  watchReceivedAttestations(): Subscribable<Attestation[]>   // to=me
}
