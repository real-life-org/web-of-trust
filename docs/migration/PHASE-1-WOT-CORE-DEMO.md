# Phase 1: WoT Core + Demo — Sprint Plan

## Ziel

Am Ende dieser drei Wochen ist `@web_of_trust/core` eine stand-alone publizierbare TypeScript-Bibliothek, deren Verhalten jede normative Regel der WoT-Spec messbar erfüllt. Die Demo-App nutzt sie zu 100% über React-Hooks. Drittkonsumenten können das Paket installieren, ohne die Demo zu kennen.

## Endzustand (Sprint-Erfolg)

| # | Was steht am Ende |
|---|---|
| 1 | `services/*` (EncryptedSyncService, GroupKeyService, ProfileService) gelöscht; Funktionalität in der spec-korrekten Layer — reine Crypto-Primitive in `protocol/sync/`, Workflows in `application/*` |
| 2 | `pnpm pack` produziert installierbares Tarball, `scripts/smoke-third-party-consumer.mjs` grün in CI, `exports`-Map sauber, README dokumentiert Subpaths |
| 3 | Demo zu 100% über Hooks: ESLint-Regel verhindert direkte Core-Imports außerhalb von `hooks/wot/` und `runtime/` |
| 4 | `pnpm --filter @web_of_trust/core test/typecheck/build` + `pnpm --filter demo test/build` + `npm run validate` in `wot-spec` grün |
| 5 | `SPEC-AUDIT.md` ohne offene `blocker`-Drifts |

## 3-Wochen-Sprint (wochengranular)

| Woche | Schwerpunkt | Spec-Anker |
|---|---|---|
| **W1** ✅ geliefert | `1.B.3-encrypted-sync` in [PR #178](https://github.com/real-life-org/web-of-trust/pull/178): `encryptOneShot`/`decryptOneShot` in `protocol/sync/encryption.ts`, alle 32 Call-Sites OneShot | Sync 001 Z.103-105 |
| **W2** ✅ geliefert | `1.B.3-group-key` (#184 ✅) → `1.B.3-profile-service` (#186 ✅) → `1.B.3-member-key-directory` (#188 ✅) | Sync 003, 004, 005; Trust 002 |
| **W3** | Sequenziell: ~~`1.B.3-key-rotation`~~ ✅ → **Adapter-Audit (atomar 4 Inbox-Typen)** → `1.B.2-verification` → `1.B.3-sync-recovery + canonical-removal-cleanup` → `1.B.3-discovery-recovery + discovery-attestations` → `1.B.3-device-keys` → `1.B.3-admin-management` → `1.D Demo-Hooks` → `1.E Test-Migration` → `1.C Standalone-Publikation (+ NodeNext-Fix)` | Sync 003 §Capability-JWS + §Envelope; Sync 004 §Recovery; Sync 005 §Admin; Trust 002; Identity 004 |

**Reihenfolge-Korrektur 2026-06-09 (Anton-Entscheid):** `1.B.2-verification` rutscht aus W2 nach W3 hinter den Adapter-Audit. Befund: Demo-Sende-Pfade (`useVerification.ts`, `AttestationService.ts`) UND Empfangs-Pfade (`App.tsx` Z.45 + Z.343) sind Old-World `MessageEnvelope` mit `type: 'attestation'` / `'space-invite'` und `payload: JSON.stringify(...)`. Spec-konformer Sende-Pfad (Inner-JWS + ECIES + `inbox/1.0`-Plaintext-Envelope nach Sync 003 Z.420-466) würde alle anderen Inbox-Konsumenten brechen, weil `EncryptedMessagingNetworkAdapter` und die Demo-Listener Old-World-zentrisch sind. Wire-Format-Migration ist Adapter-Audit-Arbeit, nicht Verification-spezifisch. Die INNEN-Schicht (Trust 002 VC-JWS via `attestationService.verifyAttestationVcJws`, `application/verification/verification-workflow.ts:createVerificationAttestation`) ist bereits spec-konform.

**Reihenfolge-Korrektur 2026-06-09 (Anton-Entscheid nach W2-Abschluss):** W3 wird **sequenziell** durchgezogen, keine Worktree-Parallelisierung. Ziel ist **production-ready** Standalone — die drei #188-Folge-Slices (`canonical-removal-cleanup` integriert in `1.B.3-sync-recovery`, `discovery-attestations` integriert in `1.B.3-discovery-recovery`, neuer `1.B.3-admin-management` löst `members[0]`-SPEC-APPROX auf) werden Teil von W3, nicht "post-Phase-1". Adapter-Audit wird **atomar für alle 4 Inbox-Typen** (member-update, space-invite, key-rotation, attestation) durchgeführt — kein Compat-Shim ([[feedback_no_quick_fixes]]).

Tag-Granularität ist bewusst weggelassen — Slice-Größen verschieben sich realistisch. Wochen-Schwerpunkte sind verbindlich.

## Schichten

| Layer | Verzeichnis | Darf importieren | Darf nicht importieren |
|---|---|---|---|
| `protocol` | `packages/wot-core/src/protocol/` | reine Typen, kleine Crypto-Ports | `application`, `adapters`, `services`, React, App-Code |
| `application` | `packages/wot-core/src/application/` | `protocol`, `ports`, Domain-Typen | konkrete Adapter, `window`, `document`, `indexedDB`, direkte WebSocket/HTTP |
| `ports` | `packages/wot-core/src/ports/` | reine Typen | Adapter-Implementierungen, Workflow-Code |
| `adapters` | `packages/wot-core/src/adapters/`, `packages/adapter-yjs/`, `packages/adapter-automerge/`, App-lokale Adapter | `ports`, Wire-/Payload-Typen aus `protocol`, Plattform-APIs | `application`-Use-Cases als notwendige Abhängigkeit |
| `react` | `apps/demo/src/hooks/`, `apps/demo/src/context/` | `application`-Use-Cases, View-Model-Typen | direkte Protokoll-Erzeugung/-Verifikation außerhalb Debug |
| `app` | `apps/demo/src/runtime/`, `apps/demo/src/pages/`, `apps/demo/src/App.tsx` | alles, aber nur an der Composition Root | eigene Protokollregeln |

Tiefere Architektur-Diskussion (Spec-Familien → TS-Orte, bekannte Abweichungen, Migrationsreihenfolge) in `wot-spec/IMPLEMENTATION-ARCHITECTURE.md`.

## Slices

| Slice | Löscht | Schreibt neu | Spec-Anker |
|---|---|---|---|
| ~~`1.B.3-encrypted-sync`~~ ✅ **PR #178** | `services/EncryptedSyncService.ts` | `protocol/sync/encryption.ts`: `encryptOneShot` + `decryptOneShot` (Random-Nonce) — alle 32 produktiven Call-Sites waren OneShot, der spec-konforme Log-Pfad bleibt für späteren Sync-002-Write-Slice. Bereits vorhandenes `encryptLogPayload` (vektor-validiert) wird im späteren Slice produktiv konsumiert. | Sync 001 Z.103-105 |
| ~~`1.B.3-group-key`~~ ✅ **PR #184** | `services/GroupKeyService.ts` | `application/sync/group-key-workflow.ts` + `ports/key-management.ts` + `adapters/key-management/InMemoryKeyManagementAdapter.ts`; `applyKeyRotation` Disposition `apply`/`future-buffer`/`ignore-stale-or-duplicate` | Sync 005 Z.243-252, Z.299 §Verantwortlichkeitsgrenzen |
| ~~`1.B.3-profile-service`~~ ✅ **erledigt** (Branch `slice/1b3-profile-service`, PR offen) | `services/ProfileService.ts` (+ `services/index.ts`, `./services`-Subpath) gelöscht | `verifyJwsByDidResolver` in `protocol/identity/jws-did-verify.ts`; `buildProfilePublicationPayload`/`flattenProfilePublicationPayload` in `application/identity/profile-document.ts`; `createProfilePublicationWorkflow().signProfile` in `application/discovery/profile-publication-workflow.ts`; `HttpDiscoveryAdapter` konsumiert Workflow + `verifyProfileServiceResourceJws` + `verifyJwsByDidResolver` | Sync 004 Z.20, Z.153 |
| `1.B.2-verification` (W3, nach Adapter-Audit) | 5 Legacy-Envelope-Stellen mit `ref: createResourceRef('attestation', ...)` in `apps/demo/src/services/AttestationService.ts` (Z.154, Z.203) und `apps/demo/src/hooks/useVerification.ts` (Z.159, Z.209, Z.272) | Nach Adapter-Audit: 5 Demo-Stellen auf neuen `createInboxDeliveryWorkflow` umstellen, attestation-VC-JWS landet in spec-konformem Inbox-Envelope. Wird klein, weil Wire-Layer bereits migriert. | Sync 003 §Envelope; Trust 002 |
| ~~`1.B.3-member-key-directory`~~ ✅ **erledigt** (Branch `slice/1b3-member-key-directory`, PR offen) | — | **Member-Update-Workflow (Authority-Split nach Sync 005 Z.169-177 MUSS):** Membership-Authority raus aus Adaptern → neuer `application/spaces/member-update-workflow.ts:processMemberUpdate` delegiert an existierenden `evaluateMemberUpdateDisposition` (heute null produktiv konsumiert). Neuer Port `MemberUpdatePendingStore` + `InMemoryMemberUpdatePendingStore`. Yjs + Automerge `handleMemberUpdate` delegieren. Behebt [#181](https://github.com/real-life-org/web-of-trust/issues/181): (a) member-update buffering nach Sync 005 Z.205 `buffer-future-and-catch-up` — verworfene Messages bei fehlendem Group-Key puffern + nach Key-Import replayen (statt heute `return`); (b) `saveSpaceMetadata` dirty-check Fingerprint vervollständigt um `image`/`modules`/`appTag` + tatsächliche `memberEncryptionKeys`-Bytes (heute nur DIDs → stale Recipient-Keys möglich). | Sync 005 §member-update |
| ~~`1.B.3-key-rotation`~~ ✅ **erledigt** (Branch `slice/1b3-key-rotation`, PR offen) | Old-World key-rotation-Logik in `YjsReplicationAdapter` / `AutomergeReplicationAdapter` | `application/sync/key-rotation-workflow.ts` (`buildKeyRotationBody`/`applyKeyRotationBody`, **C1** Admin-Authority gegen `knownAdminDids`) + `application/spaces/invite-workflow.ts` (`buildSpaceInviteBody`/`applySpaceInviteBody`, kein Admin-Check Sync 005 Z.62). `createSpaceKey`/`rotateSpaceKey` minten jetzt Capability-Key-Pair + Self-Capability; `KeyManagementPort` +5 Capability-Methoden; `ed25519PublicKeyFromSeed` (Port + WebCrypto). Beide Adapter: ECIES-Container-Payload `{ecies, encryptedDocSnapshot?}` (**C6** — kein Plaintext-Key-Material), Wire-Type `'key-rotation'` (**kein Compat-Shim**), neue `brokerUrls`-Config (Demo + CLI verdrahtet). `removeMember`: key-rotation nur an verbleibende Member, member-update an verbleibende **+** entfernten (**S2**). **SPEC-DEFERRED:** Inner-JWS (`senderDid = envelope.fromDid`) bleibt für Adapter-Audit. | Sync 003 Z.218-275 §Capability-JWS; Sync 005 Z.223-258 Key-Rotation |
| **Adapter-Audit (atomar 4-Typ Wire-Migration)** (W3) | Old-World `MessageEnvelope` (`v`/`type: 'member-update' \| 'space-invite' \| 'key-rotation' \| 'attestation'`/`fromDid`/`toDid`/`createdAt: ISO`/`encoding`/`payload: JSON.stringify`/`signature`); deprecated `signEnvelope` (wot-spec#96). Atomar in **allen 4 Inbox-Typen** + `EncryptedMessagingNetworkAdapter` beidseitig + Demo-Listener (App.tsx Z.45 + Z.343 + useVerification 3 + AttestationService 2). | Neu: `protocol/identity/jws-builder.ts` (Inner-JWS-Builder, analog #186-Verifier `verifyJwsByDidResolver`); `application/messaging/inbox-delivery-workflow.ts` (generic Sender: VC-JWS/Body → Inner-JWS → ECIES → Plaintext-Envelope); `application/messaging/inbox-reception-workflow.ts` (generic Receiver: Plaintext-Parse → ECIES-Decrypt → Inner-JWS-Verify → Dispatch). Body-Schemata für 3/4 existieren in `membership-messages.ts`; `inbox/1.0` für attestation analog ergänzen. **Kein Compat-Shim** ([[feedback_no_quick_fixes]]). | Sync 003 Z.343-466 §Envelope + §Inner-JWS-Pflichtfelder; Sync 005 §Inbox-Bodies |
| `1.B.3-sync-recovery` + `canonical-removal-cleanup` integriert | — | Framework-freier State-Machine-Workflow für Generation-Gaps + Censorship-Detection. **Plus:** dockt `state.pendingRemoval`-Flag aus #188 K3 an Space-Sync-Bestätigung an — wenn canonical members list local DID nicht mehr enthält, MUSS Cleanup-Pfad (`doc.destroy`, `spaces.delete`, `deleteSpaceMetadata`) laufen. | Sync 004 §Recovery, Z.115-120; Sync 005 Z.191 (kanonische Bestätigung) |
| `1.B.3-discovery-recovery` + `discovery-attestations` integriert | — | Profile-JWS/DID-Verification in `protocol/`/`application/`, HTTP in `adapters/discovery/`. **Plus:** Rollback-Cache für `/v` + `/a` (heute nur `/p` aus #186); **Plus:** Compact-JWS-Liste für `/a`-Endpoint statt heutiger `Attestation[]`-Cast (löst #186 VE-1 SPEC-DIVERGENZ-Kommentar in `HttpDiscoveryAdapter.ts:154`). | Sync 004 Z.175-183 (Rollback ressource-unabhängig); Sync 004 Z.28 (Compact-JWS-Liste) |
| `1.B.3-device-keys` | — | Device-Key-Creation/Binding als Application-Use-Case | Identity 004 |
| `1.B.3-admin-management` (W3, NEU 2026-06-09 nach #188) | `members[0]`-SPEC-APPROX aus #188 Yjs+Automerge `handleMemberUpdate` | Volle Sync 005 Z.219-221 Admin-Liste im CRDT; `admin-add` Message-Handler (Sync 005 Z.221); `processMemberUpdate.policy.knownAdminDids` zieht jetzt aus echter Admin-Liste statt `[members[0]]`. | Sync 005 Z.219-221 §Admin-Management |
| `1.D Demo-Hooks` | direkte Core-Imports in Demo; 1 Legacy-Envelope-Stelle in `apps/demo/src/hooks/useProfileSync.ts:51` (`profile-update`); `application/authorization/AuthorizationAdapter` + `adapters/authorization/InMemoryAuthorizationAdapter` (nach Cross-Repo-Check ohne externe Konsumenten) | Hook-basierte Migration; ESLint-Regel `no-restricted-imports` für `@web_of_trust/core` außerhalb `hooks/wot/` + `runtime/`; Composition Root in `apps/demo/src/runtime/appRuntime.ts` als einzige Adapter-Wire-Stelle | — |
| `1.E Test-Migration` | Legacy-Test-Verzeichnisse | Tests in `protocol`/`application`/`adapter`/`react`/`e2e`-Buckets | — |
| `1.C Standalone-Publikation` (+ NodeNext-Fix) | NodeNext-Defekt (siehe 1.A.2 Memo): dist `.d.ts` `export *`-Wildcard-Ketten | `exports`-Map finalisiert, Smoke-Test `scripts/smoke-third-party-consumer.mjs` in CI, README mit Subpaths + "How to consume", `pnpm pack` Tarball-Artefakt. **NodeNext-Fix:** dist mit expliziten Extensions emittieren, sodass `@web_of_trust/core/application` unter `moduleResolution: NodeNext` ohne Root-Routing auflösbar wird. | — |

Vor `1.B.2-verification` (jetzt W3 nach Adapter-Audit): ~30 Min Spec-Lese zur Klärung, ob `DeliveryReceipt.status: 'accepted'` (definiert in `packages/wot-core/src/types/messaging.ts:49`) im neuen Workflow weiterverwendet wird — Sync 003 §ack/1.0 (Z.590ff) definiert `accepted` nur als Inbox-Signal. Ergebnis als Spec-Anker-Block im PR-Body.

Details zu Call-Sites, Konsumenten und Drift-Befunden pro Slice → siehe `SPEC-AUDIT.md`.

---

## Migrations-Methode

> Drift wird durch **Löschen + Neuschreiben aus Spec** behoben, nicht durch Refactor und nicht durch Verhaltens-Konservierung.

### Regel

> **Spec-konform implementieren. Alter Code wird nur konsultiert, um Konsumenten zu identifizieren — nicht um Verhalten abzulesen.**

Bei Konflikt zwischen alter Implementation und Spec gewinnt die Spec. Ohne Ausnahme. Ohne Übergangs-Periode. Ohne "wir migrieren erst mal, später korrigieren wir".

### Verbotene Anker

- "behavior-preserving" / "byte-for-byte" / "exact equivalence" als Refactor-Ziel
- "Der alte Code macht das so, also vermutlich aus gutem Grund"
- "Wir behalten das alte Verhalten erst mal um Tests grün zu halten"
- "Demo Hook macht das so" / "CLI macht das so" als Workflow-Begründung
- Optionsfragen zu Themen, die in der Spec eine MUSS/SOLL/DARF-NICHT-Regel haben

### Verfahren pro Slice

1. **Spec-Section vollständig lesen.** Spec-Zitate (Datei:Zeile + Originaltext) für jede MUSS-Regel sammeln.
2. **Konsumenten identifizieren** im alten Code via `grep`. Liste anlegen.
3. **Neuen Code aus Spec-Zitaten schreiben.** Nicht aus altem Code abschreiben. Wenn man sich versucht zu erinnern "wie war es vorher": stoppen, Spec nochmal lesen.
4. **Tests aus Spec-Test-Vektoren** (falls vorhanden) + Application-Use-Case-Tests gegen Fake-Ports.
5. **Konsumenten umhängen** auf neue API. Konsumenten-Verhalten wird gegen eigene Spec-Domäne geprüft (Demo-UX, CLI-Output), nicht gegen alte Implementation.
6. **Alte Datei löschen.** Re-Exports + `exports`-Map cleanup. Keine Bridge-Module, kein `@deprecated`-Anker, keine Shims.

### Hygiene-Regel: Workflows produzieren keine Legacy-Form

Neue `application/*`-Workflows liefern ausschließlich spec-konforme Wire-Form (Sync 003 DIDComm-Plaintext-Envelope, Sync 001 `nonce ‖ ciphertext+tag`-Blob, etc.). Wenn ein Adapter aktuell noch eine Legacy-Form wrappt (z.B. Automerge-/Yjs-Stack mit altem `MessageEnvelope` mit `v: 1`, `fromDid`, `signature`), bleibt die Legacy-Form auf Adapter-Ebene — der Workflow darf sie nicht selbst bauen oder zurückliefern. Phase 2 räumt die Adapter-Schicht auf.

### Wenn die Spec wirklich schweigt

1. Issue in `real-life-org/wot-spec` mit Label `spec-conformance`. Body: Spec-Stelle (Datei:Zeile), beobachtete Mehrdeutigkeit, 2-3 Resolution-Optionen mit Trade-offs.
2. Im Code: temporäre Wahl + `// SPEC-UNKLAR: real-life-org/wot-spec#NN`-Kommentar.
3. Im PR-Body: erzeugte Spec-Issues auflisten.

Vor Issue-Erstellung muss dokumentiert sein: "Ich habe Section X.Y vollständig gelesen, suche nach Begriff Z, finde keine Aussage" mit `grep`-Output als Beleg. Verboten: Spec-Lücke mit lokalem Workaround dauerhaft auflösen.

---

## PR-Pflichtbausteine

### Slice-Tabelle (zentrales Artefakt)

Jeder Slice-PR enthält im Body eine Tabelle, die die Migration mechanisch nachprüfbar macht:

| Spec-Regel | Neuer Modul-Ort | Alte Konsumenten | Test/Vektor | Gelöschte Legacy-Stelle |
|---|---|---|---|---|
| `wot-spec/datei:zeile` + Originalzitat | `pfad:zeile` (was die Stelle tut) | Liste der umgehängten Call-Sites (`pfad:zeile`) | Spec-Vektor-Name + Application-Use-Case-Test-Pfad | gelöschte Datei/Symbol (`pfad:zeile`) oder explizit "—" |

Eine Zeile pro Implementations-Entscheidung. Leere Tabelle ist nur für reine Struktur-Slices erlaubt und muss explizit benannt werden.

### Checkliste

- [ ] **Lösch-Blast-Radius**: bei jedem zu löschenden Symbol (Klasse, Funktion, Typ) eine Pflicht-Tabelle "Symbol → alle Fundstellen, klassifiziert nach `prod`/`test-helper`/`bench`/`own-test`". `grep` läuft gegen ALLE TypeScript-Files, nicht nur produktive. Eigenes Test-File des gelöschten Symbols wird explizit benannt. Test-Helper, die das Symbol als Forge-Tool nutzen, werden mit-migriert. Bench-Files mit. Vor dem Lösch-Commit gegen leeres Grep-Ergebnis verifizieren.
- [ ] **Doku-Sync**: für jeden umbenannten, verschobenen oder gelöschten Pfad/Symbol/Wert `grep` gegen `docs/CURRENT_IMPLEMENTATION.md`, `docs/architecture/`, `docs/reference-implementation/`, `docs/migration/`, `packages/wot-core/src/protocol/COVERAGE.md` (ab 1.C: README). Leere Liste = "gegrept, nichts gefunden", nicht "nicht gesucht".
- [ ] **Test-First-Commits markiert**: pro neuem oder verschobenem Workflow mindestens ein Application-Use-Case-Test, der zeitlich vor der Implementation liegt.
- [ ] **Scope-Stop**: Externe Runtime-Consumer (CLI, `wot-vault`, `wot-profiles`, `wot-agent-runner-prototype`, externer Code) werden NICHT stillschweigend "mitmigriert". Wenn ein Slice einen externen Consumer berührt, ist das eine bewusste Scope-Entscheidung mit Owner-Name + Begründung im PR-Body.
- [ ] **5-Punkte-Traceability-Block** (aus `reference-implementation/README.md`): Spec-Refs, Conformance-Profil, Implementation-Modul, Tests/Vektoren, Open Spec Questions.
- [ ] **Bestätigung**: kein "behavior-preserving"-Anker verwendet; alter Code wurde nur für Konsumenten-Identifikation konsultiert.

### Vorrang bei Konflikten zwischen Docs

Wenn Spec, Direktive und abgeleitete Planungs-Docs (`SPEC-AUDIT.md`, dieser Master-Plan, `legacy-boundary-map.md`, `demo-consumer-map.md`) widersprüchliche Aussagen über Layer, API-Namen, Klassifikation oder Wire-Format machen, gilt strikt:

> **Spec > Direktive > abgeleitete Docs.**

Die normative Spec gewinnt immer. Eine Direktive überschreibt die abgeleiteten Docs, wenn sie aus aktueller Spec-Lese abgeleitet ist (mit Spec-Zitat-Beleg). Abgeleitete Docs sind Audit-/Planungs-Hilfen und können veralten — sie sind nie autoritativ über die Spec oder eine spec-zitierende Direktive. Bei Konflikt: zurück zur Spec lesen, Direktive entsprechend setzen, abgeleitetes Doc im selben PR mit-korrigieren.

Loop-Review-Should-Fix wegen Spec-Drift oder Doku-Drift gilt als vermeidbar. Findings werden im Folge-Commit gefixt, nicht im Folge-PR.

---

## TDD-Reihenfolge

Verbindlich für `1.B.*` und `1.D` (reine Datei-Verschiebungen ausgenommen):

1. **Protocol-Vektor-Test** gegen `wot-spec/test-vectors/` (rot oder grün laden).
2. **Application-Use-Case-Test** mit Fake-Ports (rot). In-Memory-Stores, fixe Clocks, deterministische RNG.
3. **Workflow implementieren** bis (2) grün ist.
4. **Adapter-Contract-Test** gegen den neuen Port. Gleicher Contract läuft gegen In-Memory- und reale Adapter.
5. **React-Hook-Test** (State-Transitions, Error-Handling). Keine Crypto-Wiederholung im Hook.
6. **Refactor** bei grünen Tests.

Test schwer zu schreiben = Spec-Lücke oder Architektur-Frage. Sofort Issue, kein "ich denk's mir aus".

---

## Definition of Done

1. **`services/*` leer oder gelöscht** (EncryptedSyncService, GroupKeyService, ProfileService).
2. **Standalone-Publikation funktioniert**: `pnpm pack` Tarball, Smoke-Test grün in CI, `exports`-Map dokumentiert.
3. **Demo zu 100% via Hooks**: ESLint-Regel aktiv, 0 direkte Core-Imports außerhalb `hooks/wot/` + `runtime/`.
4. **Test-Suite grün**: `pnpm --filter @web_of_trust/core test/typecheck/build` + `pnpm --filter demo test/build` + `npm run validate` in `wot-spec`.
5. **TDD-Spur pro Workflow nachweisbar** in Commit-History oder PR-Body.
6. **`src/crypto/` minimal**: nur `envelope-auth.ts` + `index.ts` mit Spec-Divergenz-Doku (Verweis auf [wot-spec#96](https://github.com/real-life-org/wot-spec/issues/96) und Sync 003 Z.343/410) + Phase-2-Sterbe-Marker.
7. **`SPEC-AUDIT.md` ohne offene `blocker`-Drifts**: alle Befunde adressiert oder explizit nach Phase 2 verortet.
8. **Slice-Tabelle in jedem PR-Body** (siehe §PR-Pflichtbausteine).

### Harte Merge-Gates ab Slice 1.C

Ab `1.C Standalone-Publikation` werden die folgenden DoD-Items vor Merge geprüft, nicht nur "im Trend grün":

- `scripts/smoke-third-party-consumer.mjs` grün in CI (DoD #2)
- `pnpm --filter @web_of_trust/core test/typecheck/build` + `pnpm --filter demo test/build` + `npm run validate` in `wot-spec` grün (DoD #4)
- Spec-Test-Vektoren reproduziert in `protocol`-Tests

Roter Status bei einem dieser Gates blockiert den Merge bis zur Behebung — kein "wird in nachfolgendem Slice gefixt".

---

## Nicht-Ziele

- Kein `packages/wot-react/`-Paket extrahieren (Phase 2 mit RLS).
- Kein CRDT-Adapter-Stack-Refactor (Phase 2: Legacy-`MessageEnvelope`-Cleanup in Automerge + Yjs).
- Kein RLS-/HMC-Extensions-Refactor (Phase 2/3).
- Kein UI-Redesign.
- Keine DIDComm-Mediator-/JWE-Erweiterung außerhalb existierender Spec.
- Keine Mobile-Release-Pipeline-Änderungen (Phase 4).

---

## Verweise

| Dokument | Wofür |
|---|---|
| `docs/migration/SPEC-AUDIT.md` | aktuelle Drift-Befunde + Slice-Verortung pro Befund |
| `wot-spec/IMPLEMENTATION-ARCHITECTURE.md` | Layer-Regeln, Import-Regeln, Migrations-DoD |
| `wot-spec/ARCHITECTURE.md` | Arbeitsprinzipien (Implementierungsdetails dürfen Spec informieren, nicht ersetzen) |
| `wot-spec/CONFORMANCE.md` + `wot-spec/test-vectors/` | normative Profil-Definitionen + Test-Vektoren |
| `web-of-trust/docs/reference-implementation/README.md` | Authority Model, 5-Punkte-Traceability-Block für PRs |
| `web-of-trust/docs/reference-implementation/legacy-boundary-map.md` | Modul-Klassifikation |
| `web-of-trust/docs/reference-implementation/demo-consumer-map.md` | Import-Debt-Inventory, Adapter-Capability-Requirements |
| `web-of-trust/docs/wot-core-test-migration.md` | Test-Bucket-Klassifikation |
