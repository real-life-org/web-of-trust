import { Subscribable } from './Subscribable';
import { Identity } from '../../types/identity';
import { Contact } from '../../types/contact';
import { Verification } from '../../types/verification';
import { Attestation } from '../../types/attestation';
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
    watchIdentity(): Subscribable<Identity | null>;
    watchContacts(): Subscribable<Contact[]>;
    watchReceivedVerifications(): Subscribable<Verification[]>;
    watchAllVerifications(): Subscribable<Verification[]>;
    watchAllAttestations(): Subscribable<Attestation[]>;
    watchReceivedAttestations(): Subscribable<Attestation[]>;
}
//# sourceMappingURL=ReactiveStorageAdapter.d.ts.map