# Protocol Optimizations

Collection of known inefficiencies and planned optimizations in the sync and communication protocols.

---

## 1. Full-State Sync on Reconnect (Personal-Doc)

**Status:** Open
**Affects:** `PersonalNetworkAdapter` (Automerge), `YjsPersonalSyncAdapter` (Yjs)
**Introduced:** 2026-03-30

**Problem:** After every reconnect (offline → online, network switch, app start), the entire personal doc state is sent to all own devices. For a 50KB doc with frequent reconnects, this is unnecessary traffic.

**Current behavior:**
```
Reconnect →
  sendFullState()    // Complete doc state (encrypted)
  sendSyncRequest()  // Asks all devices to send their state
```

Both sides send the full state — even if nothing changed.

**Optimization:** Incremental sync instead of full-state:
```
Reconnect →
  1. Send state vector / sync fingerprint (~100 bytes)
  2. Remote compares, sends only missing changes
  3. Same in reverse direction
```

- **Yjs:** `Y.encodeStateVector()` + `Y.encodeStateAsUpdate(doc, remoteStateVector)` — built-in, just needs to be used.
- **Automerge:** `Automerge.generateSyncMessage()` / `Automerge.receiveSyncMessage()` — built-in sync protocol with automatic diff calculation.

**Priority:** Low while personal doc stays small (< 100KB). Becomes relevant with:
- Many contacts (> 500)
- Frequent reconnects (mobile networks)
- Personal doc with attachments or large data

---

## 2. Space Sync on Reconnect (Automerge)

**Status:** Bug — not implemented
**Affects:** `EncryptedMessagingNetworkAdapter` (Automerge)
**Discovered:** 2026-03-30

**Problem:** The `EncryptedMessagingNetworkAdapter` has no reconnect handler (same root cause as the old `PersonalNetworkAdapter` bug). Space data is not re-synced after offline → online. Yjs solves this via `_sendFullStateAllSpaces()` on reconnect.

**Impact:** Automerge E2E tests `key-rotation-multi-device` and `multi-device` fail (3 of 17).

**Solution:** Same pattern as the personal-doc fix: add `onStateChange('connected')` handler to `EncryptedMessagingNetworkAdapter`. More complex than personal-doc because multiple docs, group keys, and space membership are involved.

**Priority:** Medium — affects all Automerge multi-device scenarios with offline phases.

---

## 3. Echo Filtering via sentMessageIds

**Status:** Works, but not optimal
**Affects:** `PersonalNetworkAdapter`, `YjsPersonalSyncAdapter`

**Problem:** Both adapters track sent message IDs in a `Set<string>` with 30s TTL to ignore own echoes from the relay. The set grows with many messages in a short time.

**Optimization:** Instead of tracking message IDs, the relay could support an `echo: false` flag (server-side filtering). Alternatively: Bloom filter instead of Set for memory-efficient filtering.

**Priority:** Low — current Set with 30s TTL works well.

---

## 4. Encryption Overhead per Message

**Status:** Accepted
**Affects:** All sync adapters

**Problem:** Every sync message is individually encrypted with AES-256-GCM (EncryptedSyncService). With many small updates (e.g., keystroke sync), the per-message overhead is significant (nonce, auth tag, key derivation).

**Optimization:** Batching — combine multiple updates into a single encrypted message. Yjs already does this partially (updates are collected and sent as one `Y.encodeStateAsUpdate()`). Automerge could be debounced similarly.

**Priority:** Low — AES-GCM is fast, overhead is acceptable.

---

## Prioritization Criteria

Optimizations are prioritized by:
1. **User experience** — Does the user notice the delay / resource usage?
2. **Scale** — At what size does it become a problem?
3. **Complexity** — How much effort to implement?
4. **Risk** — Can the optimization introduce new bugs?
