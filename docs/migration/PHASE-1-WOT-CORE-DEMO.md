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
| **W2** | `1.B.3-group-key` → `1.B.3-profile-service` → `1.B.2-verification` → `1.B.3-member-key-directory` | Sync 003, 004, 005; Trust 002 |
| **W3** | `1.B.3-sync-recovery` + `1.B.3-discovery-recovery` + `1.B.3-device-keys` + Adapter-Audit → `1.D Demo-Hooks` → `1.E Test-Migration` → `1.C Standalone-Publikation` | Sync 004 §Recovery; Identity 004 |

Parallelisierung erlaubt: file-isolierte 1.B.3-Sub-Slices können in mehreren Worktrees parallel laufen. 1.D + 1.E ebenfalls parallel.

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
| `1.B.3-group-key` | `services/GroupKeyService.ts` | `application/sync/group-key-workflow.ts` + `ports/key-management.ts` (durable Pending-Rotation-Store) | Sync 005 Z.243-252, §Verantwortlichkeitsgrenzen |
| `1.B.3-profile-service` | `services/ProfileService.ts` | Funktionalität verteilt auf `application/discovery/*`, `application/identity/*`, `adapters/discovery/*` | Sync 004 Z.20, Z.153 |
| `1.B.2-verification` | 5 Legacy-Envelope-Stellen mit `ref: createResourceRef('attestation', ...)` in `apps/demo/src/services/AttestationService.ts` (Z.154, Z.203) und `apps/demo/src/hooks/useVerification.ts` (Z.159, Z.209, Z.272) | `application/verification/*` aus Spec; Demo-Hooks und CLI hängen sich auf neue API um | Sync 003 §Envelope; Trust 002 |
| `1.B.3-member-key-directory` | — | Member-Update-Workflow; macht `protocol/sync/space-capability.ts` (`createSpaceCapabilityJws` / `verifySpaceCapabilityJws`) produktiv konsumiert (heute nur in Tests) | Sync 005 §member-update; Sync 003 §Capability-JWS |
| `1.B.3-sync-recovery` | — | Framework-freier State-Machine-Workflow | Sync 004 §Recovery, Z.115-120 |
| `1.B.3-discovery-recovery` | — | Profile-JWS/DID-Verification in `protocol/`/`application/`, HTTP in `adapters/discovery/` | Sync 004 |
| `1.B.3-device-keys` | — | Device-Key-Creation/Binding als Application-Use-Case | Identity 004 |
| Adapter-Audit | nicht-konforme Wire-Formate | spec-konforme Adapter | Sync 003 §Envelope; Sync 004 HTTP |
| `1.D Demo-Hooks` | direkte Core-Imports in Demo; 1 Legacy-Envelope-Stelle in `apps/demo/src/hooks/useProfileSync.ts:51` (`profile-update`); `application/authorization/AuthorizationAdapter` + `adapters/authorization/InMemoryAuthorizationAdapter` (nach Cross-Repo-Check ohne externe Konsumenten) | Hook-basierte Migration; ESLint-Regel `no-restricted-imports` für `@web_of_trust/core` außerhalb `hooks/wot/` + `runtime/`; Composition Root in `apps/demo/src/runtime/appRuntime.ts` als einzige Adapter-Wire-Stelle | — |
| `1.E Test-Migration` | Legacy-Test-Verzeichnisse | Tests in `protocol`/`application`/`adapter`/`react`/`e2e`-Buckets | — |
| `1.C Standalone-Publikation` | — | `exports`-Map finalisiert, Smoke-Test, README mit Subpaths + "How to consume" | — |

Vor `1.B.2-verification`: ~30 Min Spec-Lese zur Klärung, ob `DeliveryReceipt.status: 'accepted'` (definiert in `packages/wot-core/src/types/messaging.ts:49`) im neuen Workflow weiterverwendet wird — Sync 003 §ack/1.0 (Z.590ff) definiert `accepted` nur als Inbox-Signal. Ergebnis als Spec-Anker-Block im PR-Body.

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
