# Web of Trust + Human Money Core in Tauri

A guide for combining TypeScript (WoT) and Rust (HMC) in a single Tauri 2.0 application.

---

## How Tauri Works

Tauri apps have two layers:

```
┌─────────────────────────────────────────┐
│           WebView (Frontend)            │
│                                         │
│  React / HTML / CSS / JavaScript        │
│  npm packages run here                  │
│  Yjs (CRDT) runs here                   │
│  @web_of_trust/core runs here           │
│                                         │
├─────────────────────────────────────────┤
│          Tauri Bridge (IPC)             │
│  invoke("command", { args })  ──────►   │
│  ◄──────  Result / Event                │
├─────────────────────────────────────────┤
│           Rust Backend                  │
│                                         │
│  human_money_core (crate)               │
│  Native APIs (Keychain, Push, NFC)      │
│  File system, SQLite                    │
│                                         │
└─────────────────────────────────────────┘
```

This is the standard Tauri approach — not a workaround. The WebView runs the UI and any JavaScript/TypeScript libraries. The Rust backend handles everything that benefits from native execution. The Tauri Bridge connects both via type-safe IPC commands.

## Concrete Example: WoT + HMC

```
WebView (TypeScript):                Rust Backend:

  import { WotIdentity }             #[tauri::command]
    from '@web_of_trust/core'        fn create_voucher(
                                       amount: u64,
  // Create identity                   recipient: String,
  const identity =                   ) -> Result<Voucher> {
    new WotIdentity()                  let wallet = get_wallet()?;
  await identity.create(pass)         wallet.create_voucher(
                                         amount, &recipient
  // Verify someone                    )
  // (happens in WebView)            }
  // Attestations, Trust Graph
  // all in TypeScript               #[tauri::command]
                                     fn verify_voucher(
  // Pay with voucher                  voucher: Vec<u8>,
  // (calls into Rust)               ) -> Result<bool> {
  const result = await invoke(         let wallet = get_wallet()?;
    'create_voucher',                  wallet.verify(voucher)
    { amount: 50, recipient: did }   }
  )
```

## What Runs Where

| Component | Where | Why |
| --- | --- | --- |
| React UI | WebView | Standard web UI |
| WoT Core (identity, verification, attestations, trust graph) | WebView (TS) | Already built, works in browser too |
| Yjs (CRDT sync) | WebView | JavaScript library, stays in JS |
| HMC (vouchers, micro-chains, double-spend detection) | Rust backend | Sebastian's existing Rust crate |
| Keychain / Keystore | Rust backend | Native API, not available in WebView |
| Push Notifications | Rust backend | Native API |
| File Storage / SQLite | Rust backend | Better performance, no IndexedDB limits |

## The Bridge in Practice

Tauri commands are defined in Rust and callable from TypeScript:

```rust
// src-tauri/src/main.rs

#[tauri::command]
fn get_trust_score(my_did: String, target_did: String) -> Result<f64, String> {
    // This could call into WoT Rust code (future)
    // or return data that the WebView WoT computes
    Ok(0.75)
}

#[tauri::command]
fn transfer_voucher(voucher_id: String, recipient_did: String) -> Result<Receipt, String> {
    let wallet = get_wallet().map_err(|e| e.to_string())?;
    wallet.transfer(&voucher_id, &recipient_did)
        .map_err(|e| e.to_string())
}
```

```typescript
// In React component
import { invoke } from '@tauri-apps/api/core'

const score = await invoke<number>('get_trust_score', {
  myDid: identity.getDid(),
  targetDid: recipient,
})

const receipt = await invoke<Receipt>('transfer_voucher', {
  voucherId: voucher.id,
  recipientDid: recipient,
})
```

Type safety is maintained through Tauri's code generation.

## What This Means for Sebastian

1. **HMC stays in Rust** — `human_money_core` is added as a Cargo dependency in `src-tauri/Cargo.toml`. No changes needed.
2. **WoT runs in the WebView** — `@web_of_trust/core` is an npm dependency. Identity, verification, attestations, trust graph all work in TypeScript.
3. **They communicate via Tauri commands** — when a voucher transfer needs trust verification, the WebView calls WoT (TS), then calls HMC (Rust via invoke).
4. **Same app runs on iOS, Android, Desktop** — Tauri 2.0 supports all three.
5. **Web version possible** — the WebView code (React + WoT) also runs as a standalone web app, just without HMC features.

## Future: Shared Rust Core

If the WoT Core is eventually ported to Rust (see [wot-rust-migration.md](wot-rust-migration.md)), both libraries would run natively in the Rust backend. The WebView would only contain the UI. This is the long-term vision — but not required to start building today.

Alternatively, Sebastian could implement the WoT protocol in Rust independently, using the [WoT Protocol Specification](wot-protocol-spec.md) to ensure compatibility.
