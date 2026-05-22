import type { Contact, ContactStatus } from '@web_of_trust/core/types'

/**
 * ContactService - Business logic layer for contact management.
 *
 * Uses a contact-only storage port so the demo contact flow does not depend
 * on broader legacy storage APIs.
 */
export interface ContactStoragePort {
  addContact(contact: Contact): Promise<void>
  getContacts(): Promise<Contact[]>
  getContact(did: string): Promise<Contact | null>
  updateContact(contact: Contact): Promise<void>
  removeContact(did: string): Promise<void>
}

export class ContactService {
  constructor(private storage: ContactStoragePort) {}

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
