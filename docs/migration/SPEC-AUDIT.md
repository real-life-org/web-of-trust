# Spec-Conformance-Audit (Phase 1.F)

**Erstausgabe**: 2026-06-08 (Rebuild gegen `spec-vnext` @ `1e39f4d`)
**Audit-Subjekt**: `web-of-trust` `spec-vnext`
**Methodik**: § 1.F im Master-Plan + § Methode für Workflow-/Service-Migration (Variante B)
**Auditor**: Claude-Session 2026-06-08, jede Behauptung verifiziert per `grep` + `Read` gegen den echten Code; Memory wurde NICHT als Quelle akzeptiert.

> **Variante-B-Prinzip**: Drift-tragender Code wird **ersatzlos gelöscht und neu aus Spec geschrieben**, nicht "refaktoriert". Audit klassifiziert nur — Behebung passiert in 1.B.3-Sub-Slices oder eigenen 1.F.N-Slices.

> **Disziplin dieses Audits**: Jede Pfad-/Zeilen-Angabe wurde am Working-Tree von `docs/spec-audit-f0` (head: `b9975ea`, base: `spec-vnext` @ `1e39f4d`) verifiziert. Wo eine frühere Version dieses Audits einen ungenauen Scope (z.B. "Yjs-Stack nicht direkt") oder eine ungenaue Stellen-Zahl hatte, ist die korrigierte Form unten + im Tabellen-Anhang dokumentiert. Cross-Repo-/Public-API-Konsumenten wurden NICHT geprüft — alle "0 Konsumenten"-Aussagen sind in-repo + non-test.

---

## 1.F.0 — Retroaktiver Spot-Check der gemergten Slices

### 1.A.2 — capabilities + AuthorizationAdapter (PR #163)

**Audit-Frage**: Ist die Verwendung von `capabilities` und `AuthorizationAdapter` nach dem Move spec-konform, oder Legacy-Übernahme?

**Spec-Anker**: [wot-spec#95](https://github.com/real-life-org/wot-spec/issues/95) — Antons Resolution: `capabilities.ts` ist nicht-normativ (UCAN-style App-Level), korrekt in `application/authorization/`, abgegrenzt von `protocol/sync/space-capability.ts` (normative Sync-005-Form).

**Befunde:**

| Stelle | Klassifikation | Begründung |
|---|---|---|
| `application/authorization/capabilities.ts` (Move nach `application/`) | ✅ **konform** | Entspricht #95-Entscheidung. UCAN-style ist nicht normativ. Datei vorhanden, Re-Export via `application/authorization/index.ts:2`. |
| `adapters/vault/VaultClient.ts:9` (Import) + `:220` (Aufruf von `createCapability`) | ✅ **konform** | Vault-HTTP-Auth (Bearer Token + signed Capability per Request). Einziger produktiver in-repo Konsument von `createCapability`. |
| `application/authorization/AuthorizationAdapter.ts` (Port-Typ) + `adapters/authorization/InMemoryAuthorizationAdapter.ts` (Impl) | ⚠️ **drift:minor (toter Code)** | **Keine in-repo non-test Konsumenten.** Re-Exports in `src/index.ts:72,141` + `application/authorization/index.ts:16` + `adapters/authorization/index.ts:1`. Datei-Kopf-Kommentar in `AuthorizationAdapter.ts:23` sagt selbst `"InMemoryAuthorizationAdapter (tests)"`. Cross-Repo-/Public-API-Konsumenten nicht geprüft. |
| `protocol/sync/space-capability.ts` (normative Sync-005-Form) | ⚠️ **drift:minor (toter Code, NEU)** | Exportiert via `protocol/index.ts:38`. `createSpaceCapabilityJws` / `verifySpaceCapabilityJws` werden **nur in Tests** aufgerufen. Kein produktiver in-repo Konsument. Field-Name-Referenzen in `membership-messages.ts` (`spaceCapabilitySigningKey`) zählen nicht als Funktions-Konsum. Cross-Repo nicht geprüft. |

**Drift-Befunde:**

- **A2-1**: `AuthorizationAdapter`-Port + `InMemoryAuthorizationAdapter` haben keine in-repo non-test Konsumenten. **Klassifikation: drift:minor (tote Architektur)**.
- **A2-2** (NEU, im ursprünglichen Audit nicht erfasst): `protocol/sync/space-capability.ts` (`createSpaceCapabilityJws`/`verifySpaceCapabilityJws`) ist exportiert + spec-zitiert, aber **nicht produktiv konsumiert** — Drift gegen Sync 005 ist hier nicht durch Code-Verhalten getrieben, sondern durch fehlende Integration. **Klassifikation: drift:minor (toter Code mit spec-normativem Inhalt)** — Lösch-Entscheidung NICHT trivial, da Sync 005 §member-update den JWS-Pfad braucht; vermutlich Re-Aktivierung in 1.B.3-member-key-directory.

**Verortung A2-1**:

- **Option a)** Ersatzlos löschen — `ports/AuthorizationAdapter`-Export entfernen, `adapters/authorization/` löschen, Root-Index Re-Export entfernen. Tests gehen mit weg. Voraussetzung: Cross-Repo-Konsumenten-Check bestätigt 0.
- **Option b)** Klar als "geplant für Phase 2, kein Produktiv-Code" markieren — Datei-Kopf-Kommentar mit Verweis.

Empfehlung: **a) Löschen**, sobald Cross-Repo-Check bestätigt. Wenn Phase 2 einen Authorization-Port braucht, schreiben wir ihn spec-zuerst.

**Verortung A2-2**: NICHT löschen. In 1.B.3-member-key-directory soll der Sync-005-konforme Member-Update-Pfad `space-capability` produktiv konsumieren. Bis dahin: Marker im Datei-Kopf-Kommentar.

---

### 1.B.2-ack — `accepted`-Flag-Implementation (PR #166)

**Audit-Frage**: Ist die `accepted`-Flag-Implementation in Demo wirklich spec-konformes Publish-Consent (Holder steuert eigene Profil-Discovery), oder schmuggelt sie irgendwo Trust-Akzeptanz-Semantik mit (Spec-Drift gegen Trust 001)?

**Spec-Anker**:

- `wot-spec/02-wot-trust/001-attestations.md` Z.147 + Z.149 — kein `attestation-ack`, keine semantische Annahmebestätigung wird ZURÜCKGESENDET.
- `wot-spec/03-wot-sync/004-discovery-and-recovery.md` — `/p/{did}/a` Profile-Service Attestation-List ist die normative Profil-Veröffentlichung.

**Befunde zur Audit-Frage:**

| Stelle | Klassifikation | Begründung |
|---|---|---|
| `apps/demo/src/services/AttestationService.ts:243-244` — `setAttestationAccepted(id, accepted)` API | ✅ **konform** | Reine Storage-Delegation (`this.storage.setAttestationAccepted(...)`). Kein `messaging.send(...)` Call → keine Wire-Nachricht zurück an Issuer. |
| `apps/demo/src/hooks/useProfileSync.ts:88-96` — filtert `meta?.accepted` und publiziert via Discovery | ✅ **konform** | Holder publiziert Attestation-Liste via `discovery.publishAttestations()`. `accepted`-Flag gatet Sichtbarkeit — exakt das, was Sync 004 vorsieht. |
| `apps/demo/src/adapters/AutomergeStorageAdapter.ts:237-250` — `setAttestationAccepted`-Persistenz | ✅ **konform** | Pure `changePersonalDoc(...)` Mutation. Kein Wire-Verhalten. |
| `apps/demo/src/services/AttestationService.ts:162` + `:210` — `receipt.status === 'accepted'` | ⚠️ **drift:offen (Naming + Spec-Verankerung unklar)** | `DeliveryReceipt.status: 'accepted'` ist in `packages/wot-core/src/types/messaging.ts:49` als wot-core API-Surface definiert. Sync 003 §ack/1.0 definiert `accepted` als **Inbox-Acceptance-Signal** (Z.624: "bestaetigt nicht, dass ein Inhaltsartefakt semantisch angenommen wurde"). Mapping zwischen wot-core API und Sync 003 wire-Form ist nicht explizit dokumentiert. **Nicht im Scope dieser Audit-Frage**, aber für 1.B.2-verification-v2 zu klären. |

**Antwort auf die Audit-Frage**: Die `accepted`-Flag-Implementation selbst (Storage-Mutation + Discovery-Publish-Gating) schmuggelt KEINE Trust-Akzeptanz-Semantik. Sie ist Publish-Consent, wie spec-konform vorgesehen.

**Aber:** im gleichen Datei-Bereich + verwandten Hooks fanden sich Drifts, die nicht zur `accepted`-Audit-Frage gehören, aber kritisch sind:

**Drift-Befund B2ack-1: Legacy-MessageEnvelope mit `ref` in Demo (5 Stellen)**

`apps/demo/src/` baut an **fünf Stellen** Legacy-`MessageEnvelope` mit `ref: createResourceRef('attestation', ...)`. Alle nutzen Legacy-Form (`v: 1`, `fromDid`, `toDid`, `createdAt`, `encoding`, `payload`, `signature`, `ref`) statt Sync 003 §Envelope (`id`, `typ`, `type`, `from`, `to`, `created_time`, `body`).

| Datei | Zeile | Funktion |
|---|---|---|
| `apps/demo/src/services/AttestationService.ts` | 154 | `retryAttestation` (Retry-Pfad) |
| `apps/demo/src/services/AttestationService.ts` | 203 | `createAttestation` (Create-Pfad) |
| `apps/demo/src/hooks/useVerification.ts` | 159 | `confirmAndRespond` |
| `apps/demo/src/hooks/useVerification.ts` | 209 | `confirmIncoming` |
| `apps/demo/src/hooks/useVerification.ts` | 272 | `counterVerify` |

(Der ursprüngliche Audit-Stand nannte nur die zwei AttestationService-Stellen, die drei `useVerification.ts`-Stellen waren übersehen.)

**Spec-Anker**: Sync 003 §Envelope (`wot-spec/03-wot-sync/003-transport-und-broker.md` Z.343-392 Felder-Tabelle) + [web-of-trust#175](https://github.com/real-life-org/web-of-trust/issues/175) (createResourceRef als Sync-003-Drift).

**Klassifikation: drift:blocker**. Fix muss ALLE fünf Stellen adressieren, sonst bleibt ein Pfad mit derselben Drift stehen. Gehört in 1.B.2-verification-v2 (das den spec-konformen DIDComm-Plaintext-Envelope baut, den AttestationService + useVerification dann konsumieren).

**Drift-Befund B2ack-2: Legacy-MessageEnvelope OHNE `ref` in useProfileSync (1 Stelle)**

`apps/demo/src/hooks/useProfileSync.ts:51-61` baut einen `profile-update`-Envelope in Legacy-Form (`v: 1`, `fromDid`, `toDid`, `payload`, `signature: ''`), aber OHNE `ref`. Selbe Legacy-Form-Drift wie B2ack-1, andere Drift-Subkategorie.

**Klassifikation: drift:minor (Legacy-Form, kein `ref`)**. Gehört in den allgemeinen Adapter-/Demo-Cleanup für Sync-003-Envelope-Migration.

**Drift-Befund B2ack-3: `DeliveryReceipt.status: 'accepted'` Verankerung unklar**

Wie oben: `DeliveryReceipt.status` ist wot-core API-Surface, Sync 003 ack/1.0 ist Inbox-only-Wire-Format. Mapping ist nicht explizit dokumentiert. **Klassifikation: drift:offen**. Vor 1.B.2-verification-v2 zu klären.

---

## 1.F-Quervergleich: Adapter-Layer-Drift (CRDT-Stack)

**Konsumenten-Inventur Legacy-`MessageEnvelope`-Format** (alle Produktiv-Konstruktor-Stellen, verifiziert via `grep` + Read im gesamten Monorepo):

| Stack | Datei | Konstruktionen | Zeilen | nutzt `ref`? |
|---|---|---:|---|---|
| **Automerge** | `packages/adapter-automerge/src/AutomergeReplicationAdapter.ts` | 5 | 759, 786, 813, 871, 898 | nein |
| **Yjs** | `packages/adapter-yjs/src/YjsReplicationAdapter.ts` | 10 | 531, 635, 667, 739, 785, 1010, 1201, 1499, 1520, 1782 | nein |
| **Demo** | `apps/demo/src/hooks/useVerification.ts` | 3 | 149, 199, 262 | **ja (alle 3)** |
| **Demo** | `apps/demo/src/services/AttestationService.ts` | 2 | 144, 193 | **ja (beide)** |
| **Demo** | `apps/demo/src/hooks/useProfileSync.ts` | 1 | 51 | nein |
| **Core / Relay / Vault** | — | 0 | — | — |

**Total: 21 produktive `MessageEnvelope`-Konstruktor-Stellen über 5 Files. Demo-Stack ist einziger `ref`-Konsument (5 von 6 Demo-Stellen).**

**Spec-Anker**: Sync 003 Z.343-392 (Felder-Tabelle) — normative DIDComm-Plaintext-Envelope-Form (`id`, `typ`, `type`, `from`, `to`, `created_time`, `thid`, `pthid`, `body`). Legacy-`MessageEnvelope`-Format ist Phase-2-Sterbe-Material (siehe DoD #17 im Master-Plan + [wot-spec#96](https://github.com/real-life-org/wot-spec/issues/96)).

**`createResourceRef`-Konsumenten-Inventur** (produktiv):

| Datei | Zeilen | Verwendung |
|---|---|---|
| `apps/demo/src/hooks/useVerification.ts` | 159, 209, 272 | `attestation`-Ref im Envelope |
| `apps/demo/src/services/AttestationService.ts` | 154, 203 | `attestation`-Ref im Envelope |
| `packages/wot-core/src/adapters/vault/VaultClient.ts` | 224 | `space`-Invite-Ref (Vault-interner Use-Case, separat) |

Total: 6 produktive `createResourceRef`-Stellen. 5 davon in Demo-Attestation-/Verification-Pfaden (alle drift:blocker für 1.B.2-verification-v2). 1 in VaultClient (eigener Vault-Auth-Kontext).

**Klassifikation Adapter-Stack** (Automerge + Yjs Replication Adapters):

- **drift:blocker für Phase 2**, **drift:minor für Phase 1** — innerhalb Phase 1 ist der CRDT-Adapter-Stack bewusst Legacy (siehe `crypto/envelope-auth.ts` `@deprecated`-Marker + Master-Plan DoD #17). Phase-1-Refactor des Adapter-Stacks ist nicht im Scope.

**Konsequenz für Phase 1 1.B.3**: Neue Workflows (`application/sync/encrypted-change-workflow.ts`, `application/verification/*`) dürfen **nicht** Legacy-`MessageEnvelope`-Form produzieren oder davon abhängen. Sie liefern spec-konforme DIDComm-Plaintext-Envelope-Form (oder rohes Crypto-Material, das der Adapter dann legacy-wrappt — letzteres ist bewusst dokumentierte Phase-1-Übergangs-Grenze).

**Helper-Funktionen**: `signEnvelope()` (Legacy-Signatur-Wrapper, kein interner Bau). `makeEnvelope()` in `packages/wot-core/tests/EnvelopeAuth.test.ts` (Test-only). Keine produktiven Builder wie `buildEnvelope`, `createMessageEnvelope`.

---

## 1.B.3-encrypted-sync — Vor-Audit (vor Umsetzung)

**Konsumenten-Inventur `EncryptedSyncService.encryptChange` / `decryptChange`** (vollständig, beide Adapter-Stacks):

| Stack | Datei | encryptChange | decryptChange |
|---|---|---:|---:|
| **Automerge** | `packages/adapter-automerge/src/PersonalDocManager.ts` | 1 (Z.446) | 1 (Z.355) |
| **Automerge** | `packages/adapter-automerge/src/EncryptedMessagingNetworkAdapter.ts` | 1 (Z.166) | 1 (Z.111) |
| **Automerge** | `packages/adapter-automerge/src/AutomergeReplicationAdapter.ts` | 2 (Z.484, 731) | 4 (Z.334, 351, 379, 396, 1016) |
| **Automerge** | `packages/adapter-automerge/src/PersonalNetworkAdapter.ts` | 1 (Z.215) | 1 (Z.101) |
| **Yjs** | `packages/adapter-yjs/src/YjsPersonalDocManager.ts` | 2 (Z.354, 560) | 2 (Z.385, 401) |
| **Yjs** | `packages/adapter-yjs/src/YjsPersonalSyncAdapter.ts` | 1 (Z.145) | 1 (Z.97) |
| **Yjs** | `packages/adapter-yjs/src/YjsReplicationAdapter.ts` | 6 (Z.522, 607, 664, 770, 1489, 1677, 1768) | 4 (Z.942, 997, 1183, 1244, 1283, 1365) |
| **wot-core (Benchmark)** | `packages/wot-core/src/...` Benchmark-Datei | 4 | 4 |
| **Total produktiv** | **7 Files** | **14** | **15** |

**Korrektur gegenüber Audit-Erstausgabe**: Die Erstausgabe behauptete "alle ~14 Call-Sites im Automerge-Stack, Yjs-Stack nutzt EncryptedSyncService nicht direkt". Das war **falsch** — Yjs nutzt ihn massiv (3 Files, ~14 Calls). Korrigiert via [web-of-trust#177](https://github.com/real-life-org/web-of-trust/issues/177). Insgesamt **~29 produktive Call-Sites über 7 Files** in beiden Adapter-Stacks; zusätzlich Benchmark-Aufrufe in wot-core (kein Produktiv-Code).

**Re-Exports** (Konsumenten-Pfade):

```
packages/wot-core/src/index.ts:121         export { EncryptedSyncService } from './services/EncryptedSyncService'
packages/wot-core/src/services/index.ts:1  export { EncryptedSyncService } from './EncryptedSyncService'
```

Konsumenten importieren via `@web_of_trust/core` und `@web_of_trust/core/services`.

**Spec-Anker für 1.B.3-encrypted-sync**:

- `wot-spec/03-wot-sync/001-encryption-and-keys.md` Z.87 — deterministische Nonce `SHA-256(deviceId || "|" || seq)[0:12]` für Log-Payloads (MUSS).
- Sync 001 Z.103-105 — random Nonce für Snapshots, Messaging-Payloads, Personal-OneShots (MUSS), DARF NICHT deterministisch sein.
- Sync 001 Z.75 — Log-Payloads und ECIES MÜSSEN nicht-leere Klartexte verwenden.
- Sync 001 §`Encrypted Sync Frame` — Wire-Format ist `nonce ‖ ciphertext+tag` Blob.

**Bereits spec-konform vorhanden** in `packages/wot-core/src/protocol/sync/encryption.ts`:

- `deriveLogPayloadNonce(deviceId, seq)` (Z.106-116) — SHA-256(deviceId | seq)[0:12].
- `encryptLogPayload({crypto, spaceContentKey, deviceId, seq, plaintext})` (Z.118-127) → liefert Blob im `nonce ‖ ciphertext+tag` Format. Gegen `log_payload_encryption`-Vektor validiert.
- `decryptLogPayload({crypto, spaceContentKey, blob})` (Z.129-135) — erkennt Nonce aus Blob-Kopf.
- `encryptEcies({crypto, ephemeralPrivateSeed, recipientPublicKey, nonce, plaintext})` (Z.75-87) — ECIES für Peer-to-Peer. Random-Nonce. Gegen `ecies`-Vektor validiert.

**Vor-Klassifikation der Call-Sites** (Log-Payload vs. OneShot, basierend auf Kontext-Lesung):

**Log-Payload-Kandidaten** (deterministische Nonce, `(deviceId, seq)` verfügbar):

- `AutomergeReplicationAdapter.ts` Vault-Push/Restore-Pfade (Z.334, 351, 379, 396, 484)
- `PersonalDocManager.ts` Vault-Push/Restore (Z.355, 446)
- `YjsPersonalDocManager.ts` Vault-Push/Restore (Z.354, 385, 401, 560)
- Teile von `YjsReplicationAdapter.ts` (Snapshots mit Generation-Kontext)

**OneShot-Kandidaten** (Random-Nonce, kein Log-Kontext):

- `EncryptedMessagingNetworkAdapter.ts` (Z.111, 166) — Messaging-Payloads
- `PersonalNetworkAdapter.ts` (Z.101, 215) — Personal-Network-Messages
- `YjsPersonalSyncAdapter.ts` (Z.97, 145) — Personal-Network-Sync
- `AutomergeReplicationAdapter.ts` Invite-Snapshots (Z.731, 1016)
- Teile von `YjsReplicationAdapter.ts` (Multi-Device-Messages, Invite-Snapshots)

**Unklar** (verlangt im Slice 1.B.3-encrypted-sync Lesung pro Call-Site mit ±10 Zeilen Kontext + Klassifikations-Entscheidung im PR-Body):

- mehrere `YjsReplicationAdapter.ts`-Stellen (zu viele unterschiedliche Send-/Sync-Pfade)

**Methode für 1.B.3-encrypted-sync** (per § Methode für Workflow-/Service-Migration):

1. Pro Call-Site Lesung + Klassifikation (Log-Payload / OneShot / Unklar). Klassifikations-Tabelle im PR-Body.
2. Log-Payload-Call-Sites → `protocol/sync/encryption.ts:encryptLogPayload` direkt aufrufen oder über schlanken Application-Layer-Helper.
3. OneShot-Call-Sites → neuer Helper `encryptOneShot(opts)` in `application/sync/` der intern AES-GCM mit Random Nonce baut, im selben Blob-Format wie Log-Payload (kompatibler Decrypt-Pfad).
4. `Unklar`-Call-Sites: im Slice einzeln klassifizieren, ggf. mit Anton synchronisieren bevor umgehängt.
5. **`services/EncryptedSyncService.ts` ersatzlos löschen**, Root-Index-Export entfernen, services-Index-Export entfernen.
6. PR-Body: Spec-Zitat-Block + vollständige Call-Site-Klassifikations-Tabelle + Konsumenten-Migration-Trace.

---

## Status & Nächste Schritte

| Befund | Klassifikation | Slice |
|---|---|---|
| **A2-1**: `AuthorizationAdapter` + `InMemoryAuthorizationAdapter` keine in-repo non-test Konsumenten | drift:minor (tote Architektur, cross-repo nicht geprüft) | 1.F.N-Mini oder Aufräum-Commit von 1.B.3-encrypted-sync |
| **A2-2**: `protocol/sync/space-capability.ts` exportiert aber tot | drift:minor (toter spec-normativer Code) | Re-Aktivierung in 1.B.3-member-key-directory |
| **B2ack-1**: 5× Legacy-Envelope mit `ref` in Demo (AttestationService + useVerification) | drift:blocker | 1.B.2-verification-v2 |
| **B2ack-2**: `useProfileSync.ts:51` Legacy-Envelope ohne `ref` | drift:minor | Demo-Sync-003-Migration (Phase 1 Schluss oder Phase 2) |
| **B2ack-3**: `DeliveryReceipt.status: 'accepted'` Sync-003-Verankerung unklar | drift:offen | Vor 1.B.2-verification-v2 klären |
| **CRDT-Adapter Legacy-MessageEnvelope** (Automerge 5 + Yjs 10 Stellen) | drift:blocker für Phase 2 | Phase 2+ (außerhalb Phase 1-Scope) |
| **`services/EncryptedSyncService.ts`** Spec-Drift (random Nonce für alles) | drift:blocker | 1.B.3-encrypted-sync |
| **`services/GroupKeyService.ts`** noch nicht detailliert auditiert | (offen) | 1.B.3-group-key |
| **`services/ProfileService.ts`** noch nicht detailliert auditiert | (offen) | 1.B.3-profile-service |

**Aktion direkt jetzt**: Nach Merge dieses Audits → 1.B.3-encrypted-sync starten. Pre-Audit-Inventar ist vollständig.

**Cross-Repo-Check für A2-1 vor Lösch-Entscheidung**: separate Aktion (`grep` in `wot-vault`, `wot-profiles`, `runner`, etc.) — nicht in diesem Audit erledigt.
