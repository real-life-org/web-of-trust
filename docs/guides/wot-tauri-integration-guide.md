# Integrating Web of Trust into a Tauri App

A practical guide for adding WoT features to an existing Tauri 2.0 application, written with the Human Money App as reference.

---

## Your Starting Point

You have a Tauri 2.0 app with:
- React + TypeScript frontend
- Rust backend with your business logic (e.g., `voucher_lib`)
- BIP39 mnemonics for wallet identity
- Tauri commands bridging Rust and TypeScript

You want to add: mutual verification, attestations, trust scores, encrypted collaboration.

---

## Step 1: Install WoT in the Frontend

WoT runs as a TypeScript library in your WebView — the same place your React UI runs.

```bash
npm install @web_of_trust/core @web_of_trust/adapter-yjs
```

No Rust changes needed for this step.

## Step 2: Identity — One Mnemonic, Two Systems

Both HMC and WoT use BIP39 mnemonics. The question: same mnemonic or separate?

**Option A: Same mnemonic, different derivation paths (recommended)**

Both systems derive from the same seed but use different HKDF info strings, so the keys are cryptographically independent:

```
User's BIP39 Mnemonic (12 or 24 words)
  │
  ├─ HMC: voucher_lib derives wallet keys (existing)
  │
  └─ WoT: HKDF(seed, "wot-identity-v1") → Ed25519 (signing)
           HKDF(seed, "wot-encryption-v1") → X25519 (encryption)
```

The user has one mnemonic for everything. No second backup needed.

**In your Tauri app:**

```typescript
// Frontend: Initialize WoT identity from the same mnemonic
import { IdentityWorkflow, WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core'

const workflow = new IdentityWorkflow({
  crypto: new WebCryptoProtocolCryptoAdapter(),
})
const { identity } = await workflow.recoverIdentity({
  mnemonic,
  passphrase,
  storeSeed: false,
})

// WoT DID — derived from the same seed, different path
const did = identity.getDid()  // did:key:z6Mk...
```

```rust
// Backend: HMC still uses the same mnemonic via voucher_lib
#[tauri::command]
fn create_profile(mnemonic: String, password: String, state: tauri::State<AppState>) -> Result<(), String> {
    let mut service = state.0.lock().unwrap();
    service.create_profile(&mnemonic, None, &password)?;
    // HMC wallet keys derived from same mnemonic, different path
    Ok(())
}
```

**Important:** WoT uses an empty BIP39 passphrase for seed derivation (same mnemonic = same identity everywhere). If HMC uses a different passphrase convention, the seeds will differ even with the same mnemonic. This needs alignment — see compatibility section below.

**Option B: Separate mnemonics**

Simpler to implement but worse UX — the user must back up two sets of words. Only recommended if the seed derivation paths cannot be aligned.

## Step 3: Add Verification (QR Code Flow)

The verification flow runs entirely in TypeScript (WebView):

```typescript
import type { PublicIdentitySession } from '@web_of_trust/core'

declare const identity: PublicIdentitySession

// Alice creates a challenge (displayed as QR code)
const challenge = {
  nonce: crypto.randomUUID(),
  timestamp: new Date().toISOString(),
  fromDid: identity.getDid(),
  fromPublicKey: await identity.getPublicKeyMultibase(),
  fromName: 'Alice',
}

// Bob scans Alice's QR code, creates response
// Alice scans Bob's QR code
// Both create signed Verification documents
// → mutual verification complete, both are now contacts
```

The full flow is documented in [wot-protocol-spec.md](../spec/wot-protocol-spec.md), Section 4.

## Step 4: Connect to the WoT Relay

Messages (verifications, attestations) are delivered via a WebSocket relay:

```typescript
import { WebSocketMessagingAdapter } from '@web_of_trust/core'

const messaging = new WebSocketMessagingAdapter('wss://relay.utopia-lab.org')
await messaging.connect(identity.getDid())

// Now your app can send and receive WoT messages
```

You can also run your own relay — it is open source and sees only encrypted bytes.

## Step 5: Trust Score for Voucher Transfers

This is where WoT and HMC connect. Before accepting a voucher, query the trust graph:

```typescript
// Frontend: Check trust before accepting voucher
const trustScore = await trustGraph.getScore(myDid, senderDid)

if (trustScore >= 0.6) {
  // Accept voucher — call into Rust backend
  const result = await invoke('accept_voucher', { voucherId, senderDid })
} else {
  // Show warning: "You don't have enough trust in this person"
}
```

The trust graph runs in TypeScript. The voucher acceptance runs in Rust. The Tauri bridge connects them.

## Step 6: Show Trust in the UI

```typescript
// For any contact, show aggregated trust
const contacts = await getContacts()

for (const contact of contacts) {
  const directTrust = contact.trustLevel    // e.g., 0.7 (70%)
  const networkTrust = await trustGraph.getScore(myDid, contact.did)  // e.g., 0.35

  // Display: "Bob — Direct: 70% | Network: 35%"
}
```

---

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│                 React UI                         │
│                                                  │
│  Verification Flow    Trust Scores    Contacts   │
│  Attestation View     Profile         Vouchers   │
│                                                  │
│  ┌─────────────────────────────────────────────┐ │
│  │  @web_of_trust/core (TypeScript)            │ │
│  │  Identity, Verification, Attestations,      │ │
│  │  Trust Graph, Relay Connection              │ │
│  └─────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────┤
│               Tauri Bridge (IPC)                 │
│  invoke("accept_voucher", { ... })               │
│  invoke("get_balance", { ... })                  │
├─────────────────────────────────────────────────┤
│              Rust Backend                        │
│  ┌─────────────────────────────────────────────┐ │
│  │  voucher_lib / human_money_core             │ │
│  │  Wallet, Vouchers, Micro-Chains,            │ │
│  │  Double-Spend Detection                     │ │
│  └─────────────────────────────────────────────┘ │
│  AppState(Mutex<AppService>)                     │
└─────────────────────────────────────────────────┘
```

---

## Compatibility Checklist

Before integrating, verify these alignment points:

| Question | WoT | HMC | Action needed? |
| --- | --- | --- | --- |
| BIP39 wordlist | German (custom positive) | Standard English? | Align or use separate seeds |
| BIP39 passphrase | Empty string | ? | Must match for same-seed approach |
| Seed bytes used | First 32 bytes | ? | Must match |
| Signing algorithm | Ed25519 | Ed25519 | Compatible |
| DID format | did:key (multicodec) | ? | HMC may need to adopt did:key |

If the seed derivation differs, Option B (separate mnemonics) is safer until aligned.

---

## What Runs Where — Decision Guide

| Feature | Where | Why |
| --- | --- | --- |
| Create/unlock identity | Frontend (TS) | WoT handles key derivation |
| QR verification flow | Frontend (TS) | UI-driven, camera access |
| Attestation create/view | Frontend (TS) | Signing + display |
| Trust graph queries | Frontend (TS) | Graph computation |
| Relay connection | Frontend (TS) | WebSocket in browser |
| Voucher create/transfer | Backend (Rust) | voucher_lib business logic |
| Voucher validation | Backend (Rust) | Micro-chain verification |
| Double-spend detection | Backend (Rust) | Gossip protocol |
| Secure file storage | Backend (Rust) | Encrypted wallet files |

---

## Alternative: Rust-Native WoT

If running WoT in the WebView feels wrong for your architecture, there are two paths:

1. **Implement the WoT protocol in Rust** — Follow the [WoT Protocol Specification](../spec/wot-protocol-spec.md). This ensures compatibility with the TypeScript reference implementation. Start with DID generation (Section 1-2) and verification (Section 4).

2. **Wait for a Rust WoT library** — If the WoT Core is eventually ported to Rust (see [wot-rust-migration.md](../concepts/wot-rust-migration.md)), it could be added as a Cargo dependency alongside `voucher_lib`.

Both approaches produce compatible DIDs, signatures, and messages — the protocol spec guarantees interoperability.

---

## Next Steps

1. `npm install @web_of_trust/core` in your Tauri frontend
2. Create a WoT identity from the existing mnemonic
3. Verify that the DID is deterministic (same mnemonic → same DID)
4. Add the verification QR flow to your UI
5. Connect to the relay and test sending a verification
