import { test, expect } from '@playwright/test'
import { createIdentity, recoverIdentity } from './helpers/identity'
import { createFreshContext, waitForRelayConnected, navigateTo } from './helpers/common'
import { performMutualVerification } from './helpers/verification'
import { waitForReconnect } from './helpers/offline'

test.describe('Offline Restore', () => {
  test('seed restore on new device → relay sync → contacts appear', async ({ browser }) => {
    // Phase 1: Alice creates identity online, verifies with Bob
    const { context: alice1Ctx, page: alice1Page } = await createFreshContext(browser)
    const { context: bobCtx, page: bobPage } = await createFreshContext(browser)

    let aliceMnemonic: string
    let aliceDid: string

    try {
      const result = await createIdentity(alice1Page, { name: 'Alice', passphrase: 'alice123pw' })
      aliceMnemonic = result.mnemonic
      aliceDid = result.did

      await createIdentity(bobPage, { name: 'Bob', passphrase: 'bob12345pw' })

      await waitForRelayConnected(alice1Page)
      await waitForRelayConnected(bobPage)

      await performMutualVerification(alice1Page, bobPage)

      // Verify Bob is in contacts
      await navigateTo(alice1Page, '/contacts')
      await expect(alice1Page.getByText('Bob')).toBeVisible({ timeout: 10_000 })

      // Wait for data to sync to vault/relay
      await alice1Page.waitForTimeout(5_000)
    } finally {
      await alice1Ctx.close()
      await bobCtx.close()
    }

    // Phase 2: Alice restores on new device → data syncs via relay
    const { context: alice2Ctx, page: alice2Page } = await createFreshContext(browser)

    try {
      // Recover identity from seed
      const { did: restoredDid } = await recoverIdentity(alice2Page, {
        mnemonic: aliceMnemonic,
        passphrase: 'newdevice123',
      })

      // Same DID
      expect(restoredDid).toBe(aliceDid)

      // Wait for app to load and relay to connect
      await expect(alice2Page.getByText('Hallo,')).toBeVisible({ timeout: 10_000 })
      await waitForReconnect(alice2Page)

      // Bob should appear in contacts (synced from vault or relay personal-doc sync)
      await navigateTo(alice2Page, '/contacts')
      await expect(alice2Page.getByText('Bob')).toBeVisible({ timeout: 30_000 })
    } finally {
      await alice2Ctx.close()
    }
  })

  test('seed restore → edit profile → vault merge → contacts + new name preserved', async ({ browser }) => {
    // Phase 1: Alice creates identity, verifies with Bob, syncs to vault
    const { context: alice1Ctx, page: alice1Page } = await createFreshContext(browser)
    const { context: bobCtx, page: bobPage } = await createFreshContext(browser)

    let aliceMnemonic: string

    try {
      const result = await createIdentity(alice1Page, { name: 'Alice', passphrase: 'alice123pw' })
      aliceMnemonic = result.mnemonic

      await createIdentity(bobPage, { name: 'Bob', passphrase: 'bob12345pw' })

      await waitForRelayConnected(alice1Page)
      await waitForRelayConnected(bobPage)

      await performMutualVerification(alice1Page, bobPage)

      // Verify Bob is in contacts
      await navigateTo(alice1Page, '/contacts')
      await expect(alice1Page.getByText('Bob')).toBeVisible({ timeout: 10_000 })

      // Wait for data to sync to vault/relay
      await alice1Page.waitForTimeout(5_000)
    } finally {
      await alice1Ctx.close()
      await bobCtx.close()
    }

    // Phase 2: Alice restores on new device, edits profile, CRDT merges with vault state
    const { context: alice2Ctx, page: alice2Page } = await createFreshContext(browser)

    try {
      await recoverIdentity(alice2Page, {
        mnemonic: aliceMnemonic,
        passphrase: 'newdevice123',
      })

      // Wait for app to load and relay to connect
      await expect(alice2Page.getByText('Hallo,')).toBeVisible({ timeout: 10_000 })
      await waitForReconnect(alice2Page)

      // Wait for vault sync to complete (contacts should appear)
      await navigateTo(alice2Page, '/contacts')
      await expect(alice2Page.getByText('Bob')).toBeVisible({ timeout: 30_000 })

      // Edit profile on new device
      await navigateTo(alice2Page, '/identity')
      await alice2Page.getByText('Profil bearbeiten').click()
      await alice2Page.getByPlaceholder('Dein Name').clear()
      await alice2Page.getByPlaceholder('Dein Name').fill('Alice Neu')
      await alice2Page.getByText('Speichern').click()
      await alice2Page.waitForTimeout(2_000)

      // Verify: new name AND contacts both preserved after CRDT merge
      await navigateTo(alice2Page, '/')
      await expect(alice2Page.getByText('Hallo, Alice Neu')).toBeVisible({ timeout: 10_000 })

      await navigateTo(alice2Page, '/contacts')
      await expect(alice2Page.getByText('Bob')).toBeVisible({ timeout: 10_000 })
    } finally {
      await alice2Ctx.close()
    }
  })
})
