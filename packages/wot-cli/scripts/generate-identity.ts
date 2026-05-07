#!/usr/bin/env tsx
/**
 * Generate a new WoT identity for Eli (or any headless client).
 *
 * Usage:
 *   WOT_PASSPHRASE=secret npx tsx scripts/generate-identity.ts
 *   WOT_PASSPHRASE=secret WOT_SEED_PATH=./data/eli-seed.enc npx tsx scripts/generate-identity.ts
 *
 * Output:
 *   - Encrypted mnemonic file at WOT_SEED_PATH (default: ./data/wot-identity.enc)
 *   - DID printed to stdout
 *   - Mnemonic printed to stdout (SAVE THIS! It's the only way to recover)
 */

import { WotIdentity } from '@web_of_trust/core/application'
import { FileBasedSeedStorage } from '../src/storage/FileBasedSeedStorage.js'

const passphrase = process.env.WOT_PASSPHRASE as string
if (!passphrase) {
  console.error('Error: WOT_PASSPHRASE environment variable required')
  console.error('Usage: WOT_PASSPHRASE=secret npx tsx scripts/generate-identity.ts')
  process.exit(1)
}

const seedPath = process.env.WOT_SEED_PATH ?? './data/wot-identity.enc'

async function main() {
  const identity = new WotIdentity()

  // Generate new identity (don't use browser storage)
  const result = await identity.create(passphrase, false)

  console.log('=== New WoT Identity Generated ===')
  console.log()
  console.log(`DID: ${result.did}`)
  console.log()
  console.log('Mnemonic (SAVE THIS — only way to recover):')
  console.log(`  ${result.mnemonic}`)
  console.log()

  // Store encrypted mnemonic
  const storage = new FileBasedSeedStorage(seedPath)
  await storage.storeMnemonic(result.mnemonic, passphrase)

  console.log(`Encrypted mnemonic saved to: ${seedPath}`)
  console.log()
  console.log('Next steps:')
  console.log('  1. Save the mnemonic in a secure location')
  console.log('  2. Ask Anton to verify this DID')
  console.log(`  3. Set WOT_PASSPHRASE and WOT_SEED_PATH=${seedPath} as env vars`)
}

main().catch((err) => {
  console.error('Failed:', err)
  process.exit(1)
})
