import type { StorageAdapter, Contact, ContactStatus } from '@web.of.trust/core'

/**
 * ContactService - Business logic layer for contact management.
 *
 * Uses StorageAdapter (not a standalone IndexedDB) so contacts
 * go through the same storage backend as everything else.
 */
export class ContactService {
  constructor(private storage: StorageAdapter) {}

  async addContact(
    did: string,
    publicKey: string,
    name?: string,
    status: ContactStatus = 'pending'
  ): Promise<Contact> {
    const now = new Date().toISOString()
    const contact: Contact = {
      did,
      publicKey,
      ...(name != null ? { name } : {}),
      status,
      createdAt: now,
      updatedAt: now,
    }
    await this.storage.addContact(contact)
    return contact
  }

  async getContacts(): Promise<Contact[]> {
    return this.storage.getContacts()
  }

  async getActiveContacts(): Promise<Contact[]> {
    const contacts = await this.storage.getContacts()
    return contacts.filter(c => c.status === 'active')
  }

  async getContact(did: string): Promise<Contact | null> {
    return this.storage.getContact(did)
  }

  async activateContact(did: string): Promise<void> {
    const existing = await this.storage.getContact(did)
    if (!existing) throw new Error('Contact not found')
    await this.storage.updateContact({
      ...existing,
      status: 'active',
      verifiedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  }

  async updateContactName(did: string, name: string): Promise<void> {
    const existing = await this.storage.getContact(did)
    if (!existing) throw new Error('Contact not found')
    await this.storage.updateContact({
      ...existing,
      name,
      updatedAt: new Date().toISOString(),
    })
  }

  async removeContact(did: string): Promise<void> {
    await this.storage.removeContact(did)
  }
}
