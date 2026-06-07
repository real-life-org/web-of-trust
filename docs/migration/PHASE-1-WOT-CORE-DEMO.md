# Phase 1: WoT Core + Demo — Master Plan

> **Operational layer.** Konkrete Anleitung für die UltraCode-Sessions, die `@web_of_trust/core` zur Spec-konformen, stand-alone publizierbaren Referenzimplementierung machen und die Demo-App vollständig darauf migrieren. Architektonische und normative Anforderungen stehen in den referenzierten Dokumenten — dieses Dokument konsolidiert nicht, sondern verweist.

## Ziel

Am Ende dieser Phase ist `@web_of_trust/core` eine **stand-alone publizierbare TypeScript-Bibliothek**, die eine zu 100% saubere Abbildung der WoT-Spec darstellt — ohne Legacy-Code, ohne implizite Architekturentscheidungen, mit klaren Schichten-Grenzen. Die Demo-App nutzt sie zu 100% über wiederverwendbare React-Hooks. Drittkonsumenten können das Paket nutzen ohne die Demo zu kennen.

## Single Source of Truth (verbindliche Grundlagen)

UltraCode darf von diesen Dokumenten nicht abweichen. **Bei Widersprüchen zwischen ihnen oder zum Status quo: Spec gewinnt, dann jüngeres Doc.**

| Dokument | Rolle |
|---|---|
| `wot-spec/IMPLEMENTATION-ARCHITECTURE.md` | Layer-Regeln, Import-Regeln, Migrationsreihenfolge, DoD (7 Punkte) für TS-Umbau |
| `wot-spec/ARCHITECTURE.md` | Arbeitsprinzipien (insb. Punkt 6: Implementierungsdetails dürfen Spec informieren, nicht ersetzen) |
| `web-of-trust/docs/reference-implementation/README.md` | Authority Model ("Programm der Replacement"), Layer-Tabelle, 5-Punkte-Traceability-Block für PRs, Mapping zu Spec-Profilen |
| `web-of-trust/docs/reference-implementation-refactor.md` | Vertical-Slices-Status, Composition Root, TDD-Strategie, Spec-Feedback-Rule |
| `web-of-trust/docs/reference-implementation/legacy-boundary-map.md` | Modul-Klassifikation, **12-Punkte DoD = unser Phase-1-Abschluss-Kriterium**, Mixed-Boundary-Findings |
| `web-of-trust/docs/reference-implementation/runtime-port-contract-map.md` | **9 Follow-Up Runner Task Candidates** als Detail-Backlog mit Prerequisites + Allowed Scope |
| `web-of-trust/docs/reference-implementation/demo-consumer-map.md` | Demo-Flows mit Spec-Profil-Mapping, **Import-Debt-Inventory** (13 Stellen), Adapter-Capability-Requirements |
| `web-of-trust/docs/wot-core-test-migration.md` | Test-Klassifikation (22 Files in Buckets) |
| Normative `wot-spec/`: `01-wot-identity/`, `02-wot-trust/`, `03-wot-sync/`, `CONFORMANCE.md`, `conformance/manifest.json`, `test-vectors/` | Spec-Quelle der Wahrheit |
| `wot-spec/decisions/0001-identity-seed-protection-conformance-bar.md` | ADR für Identity Seed Protection |

## Status quo am 2026-06-04 (nicht in Docs aktualisiert)

Vor UltraCode-Sessions wird ein **separates Doc-Konsistenz-Update** die nachfolgenden Inkonsistenzen beheben (eigene PR, kein UltraCode):

- `IMPLEMENTATION-ARCHITECTURE.md` "Bekannte Abweichungen Punkt 2" (Ports in `adapters/interfaces/`) ist **erledigt** (0 Files dort, 16 in `src/ports/`).
- `legacy-boundary-map.md` Z.28 referenziert `src/identity/WotIdentity.ts` — **Verzeichnis entfernt**, Legacy WotIdentity ist weg.
- `runtime-port-contract-map.md` Z.58 + README.md Z.62 referenzieren `src/ports/SeedStorageAdapter.ts` — **existiert nicht**, vermutlich in `IdentitySeedVault` konsolidiert.
- **Alle als "blocked / human-decision / pending clarification" markierten Items in den Docs sind aufgelöst.** Konkret:
  - `runtime-port-contract-map.md` "Blocked Or Human-Decision Items": **7/7 aufgelöst** durch wot-spec-PRs (#13, #15, #22, #35, #48, #53, #56, #74) und durch Trust 001 Z.147 + CONFORMANCE Z.69 (attestation-ack klar non-existent).
  - `legacy-boundary-map.md` "Ambiguous Items": **4/5 spec-aufgelöst** (capabilities/envelope-auth → Sync 003; ProfileService Boundary → Sync 004; CRDT Port-Contract → Sync 005 Z.173-175; wot-vault/wot-core-dist ist Build-Thema, kein Spec-Thema). Nur "Demo identity-change cleanup" bleibt — als bewusste Demo-Produkt-Entscheidung von Anton.
  - `demo-consumer-map.md` "Open Questions": **4/4 spec-aufgelöst** (key-rotation naming → Sync 005 Z.243; invite/member-update validation → Sync 005 §Verantwortlichkeitsgrenzen; discovery recovery → Sync 004 Z.115-120; delivery receipts → Trust 001 Z.147).
  
  Die "open"-Markierungen in allen drei Docs sind **veraltet** und werden in der Doc-Konsistenz-PR auf "resolved" mit Spec-Referenz umgestellt.
- `ROADMAP.md` vom 16.03. — strukturell veraltet, in dieser Doc-Konsistenz-PR mit Pointer zum Master-Plan versehen; vollständige Neuaufstellung nach Phase-1-Abschluss.
- `CURRENT_IMPLEMENTATION.md` vom 12.05. — vermutlich teilweise veraltet, am Phase-1-Ende neu generieren.

## Sub-Phasen

Jede Sub-Phase = eine UltraCode-Session (Worktree-isoliert, eigener PR, Output-Kontrakt fixiert vor Start).

### 1.A.1 — Querschnitt-Konsolidierung ohne Crypto (Sessions ~1) — ✅ geliefert in PR #153

Adressiert die **horizontalen** Punkte aus `IMPLEMENTATION-ARCHITECTURE.md#bekannte-abweichungen`, die nicht workflow-spezifisch sind und **nicht** am Crypto-Refactor hängen:

- **Root-Export schichten**: `package.json` `exports`-Map mit klaren Subpath-Exports (`@web_of_trust/core/protocol`, `/application`, `/ports`, `/adapters/*`). Tree-shakeable.
- **Browser-Adapter aus Core herauslösen**: `HttpDiscoveryAdapter`, `WebSocketMessagingAdapter`, IndexedDB-/LocalStorage-Adapter aus dem flachen Core-Root entfernen. Eigene Adapter-Entry-Points oder Sub-Pakete.
- **Services klassifizieren + verschieben**: `GraphCacheService`, `VaultClient`, `VaultPushScheduler` nach `adapters/` verschieben (rein adapter-only). Die 4 verbleibenden Services (`AttestationDeliveryService`, `EncryptedSyncService`, `GroupKeyService`, `ProfileService`) bleiben mit `// PHASE-1.B.x: REMOVE` / `// CLASSIFY:`-Markern bis zu ihren jeweiligen 1.B-Slices.
- Bezug: Candidate **#8** (Adapter entry-point cleanup) aus `runtime-port-contract-map.md`.

### 1.A.2 — Crypto-Entkopplung + `src/crypto/`-Entfernung (Sessions ~1, **gated**)

> **Gate**: setzt die Beantwortung der Spec-Issues [#95](https://github.com/real-life-org/wot-spec/issues/95), [#96](https://github.com/real-life-org/wot-spec/issues/96), [#97](https://github.com/real-life-org/wot-spec/issues/97) voraus. Diese Sub-Phase startet **nicht** vor den Antworten.

Befund aus 1.A.1 (PR #153 § Deferred): `src/crypto/` ist kein reiner Import-Move. Konkret blockierend:

- `src/crypto/capabilities.ts` instanziiert `WebCryptoProtocolCryptoAdapter` auf Modulebene — verletzt `protocol -/-> protocol-adapters`.
- `src/crypto/envelope-auth.ts` ruft `crypto.subtle.importKey/verify` direkt auf — Browser-Global im protocol-Layer verboten — und koppelt an `types/messaging.MessageEnvelope`.

Saubere Auflösung verlangt:

- **Port-Injektion** in `createCapability`/`verifyCapability` statt Modul-Level-`new`.
- **`envelope-auth`-Entkopplung** von `MessageEnvelope`: entweder als Transport-Auth-Schicht (Adapter-Layer) oder durch protocol-natives JCS+JWS ersetzen — abhängig von #96.
- **Capabilities-Zielschicht** (`protocol/sync` vs eigenes `protocol/trust`) — abhängig von #95.
- **`did.ts#isValidDid` + `getDefaultDisplayName`** ersatzlos streichen (#97 trivial).

Endzustand nach 1.A.2:

- `packages/wot-core/src/crypto/` ist gelöscht. Keine Aliase, Re-Export-Shims, Bridge-Module, `@deprecated`-Marker.
- `./crypto`-Subpath aus `package.json` `exports`-Map entfernt.
- `index.ts` re-exportiert nur Layer-Barrels (verbliebener A.5-Endzustand aus 1.A.1).
- Alle Konsumenten im Monorepo (Demo, CRDT-Adapter, CLI, Server-Pakete) sind auf `protocol/`-Pfade umgestellt.

### 1.B — Per-Workflow-Slices (Sessions ~3, nach Spec-Profil)

#### 1.B.1 — `wot-identity@0.1` (klein, größtenteils erledigt)

- Candidate **#1** (Identity seed-vault contract hardening) — Legacy `SeedStorage` Direct-Internal-Source-Tests entfernen, `IdentityWorkflow` als alleiniger Recovery-Pfad, runtime-spezifische Non-Extractable-Handle-Doku.
- ADR 0001 Drei-Layer-Bar respektieren.

#### 1.B.2 — `wot-trust@0.1`

- Candidate **#3** (Verification delivery workflow): Relay-Envelope-Konstruktion + Contact/Profile-Side-Effects hinter Verification-Delivery-Workflow.
- Candidate **#4** umformuliert nach Spec-Klärung: **`AttestationDeliveryService` entfernen, nicht "rewriten"**. Trust 001 Z.147 + `CONFORMANCE.md` Z.69 sagen explizit: `wot-trust@0.1` definiert KEIN `attestation-ack` und keine semantische Annahmebestätigung. Was bleibt:
  - **Sync 003 `ack/1.0` als Transport-Inbox-ACK** (Sync-Layer, normativ, getrennt vom Trust-Layer)
  - **Profil-Veröffentlichung als Trust-konforme Rückmeldung** des Holders (Application-Workflow)
  - Jede Demo-spezifische `attestation-ack`/`received`/`accepted`-Modellierung **wird entfernt**, nicht in einen Workflow-Bucket geschoben.

#### 1.B.3 — `wot-sync@0.1` (größter Brocken)

- Candidate **#5** (Member-key directory extraction): `SpaceMemberKeyDirectory` raus aus React-Hook, in Application-/Adapter-Port.
- Candidate **#6** (Key-rotation and pending-key workflow): Sync 002 Z.231-233 + Sync 005 § member-update als Spec-Anker. Key-Management-Ports, durable pending-Stores.
- Candidate **#7** (Sync recovery orchestrator): Framework-freier Sync-Recovery-Workflow nach Sync 004 § Recovery + State-Machine.
- Candidate **#2** (Discovery/profile recovery workflow): Profile-JWS/DID-Verification-Authority in Protocol/Application, HTTP-Concerns in Discovery-Adaptern.
- Plus aus `refactor.md`: **Slice 5 Device Keys** (kein eigener Candidate, neu): Device-Key-Creation/Binding als Application-Use-Case, Delegated-Attestation-Signing exponiert.
- Plus: **Slice 6 Spaces/Sync remaining work** überlappt mit #6+#7 — Sync-Policy aus CRDT-Adaptern in Application bewegen, Group-Key-Rotation Application-Tests.

### 1.C — Standalone-Publikation (Sessions ~1)

- `package.json` `exports`-Map (knüpft an 1.A an, hier wird die Publish-Schnittstelle finalisiert).
- `pnpm pack` produziert installierbares Tarball.
- `scripts/smoke-third-party-consumer.mjs`: minimales Node-Snippet das nur `@web_of_trust/core/protocol` importiert, in CI grün.
- `README.md` von `@web_of_trust/core` mit öffentlichen Subpaths + "How to consume"-Beispiel.

### 1.D — Demo-Hooks-Konsolidierung (Sessions ~1-2)

- **Import-Debt-Inventory abarbeiten**: die 13 Stellen aus `demo-consumer-map.md` über Application-Workflows / Ports lösen.
- **60 noch nicht migrierte Demo-Files** auf wot-core via Hooks umstellen (heute 34/94 = 36%, Ziel 100%).
- **Hook-Inventar konsolidieren**: 16 existierende Hooks reviewen, Doppelungen zusammenführen, App-agnostische Signaturen.
- **Composition Root sauber halten**: `apps/demo/src/runtime/appRuntime.ts` als einzige Adapter-Wire-Stelle. `AdapterContext.tsx` entlasten — Recovery/Migration/Sync-Orchestrierung in Application-Use-Cases.
- **ESLint-Regel**: `no-restricted-imports` für `@web_of_trust/core` außerhalb von `hooks/wot/` und `runtime/`.
- Candidate **#9** (Demo runtime reset adapter): IndexedDB-Cleanup als expliziter Runtime-Reset-Adapter, nicht React-Provider-Verhalten.

### 1.E — Test-Migration (Sessions ~1)

- Nach `wot-core-test-migration.md`-Klassifikation jeden Test in seinen Bucket (`protocol` / `application` / `adapter` / `react` / `e2e`) bringen.
- **Migrations-Regel**: keine Legacy-Test-Löschung ohne äquivalenten Ersatz auf der korrekten Schicht.
- Endergebnis: keine Tests mehr in legacy-Verzeichnissen oder gemischten Buckets. Tests in `apps/demo/` analog klassifiziert.
- Kann parallel zu 1.D laufen.

## TDD-Verbindlichkeit

Quelle: `reference-implementation-refactor.md#tdd-strategy`. **Verbindlich** für jede Sub-Phase mit neuer oder verschobener Workflow-Logik (1.B.* und alle 1.D-Hooks). Reine Datei-Verschiebungen ohne Verhaltensänderung sind ausgenommen.

Reihenfolge pro Workflow-Slice:

1. **Protocol-Vektor-Test** (rot oder grün laden) — direkt gegen `wot-spec/test-vectors/`. Falls ein nötiger Vektor fehlt: Spec-Issue (siehe Spec-Härtung-Loop) und temporär lokale Fixture mit `// SPEC-UNKLAR:`-Kommentar.
2. **Application-Use-Case-Test mit Fake-Ports** (rot). In-Memory-Stores, fixe Clocks, deterministische RNG. Testet das Produktverhalten, nicht die UI.
3. **Workflow implementieren** bis (2) grün ist.
4. **Adapter-Contract-Test** (gegen den neuen Port). Gleicher Contract läuft gegen In-Memory- und reale Adapter.
5. **React-Hook-Test** (State-Transitions, Error-Handling). Keine Crypto-Wiederholung im Hook.
6. **Refactor** bei grünen Tests.

Operative Konsequenzen:

- **Test-zuerst-Commits sind erlaubt und erwünscht** (PR-Body weist sie aus). UltraCode darf einen failing-test-Commit pushen, bevor die Implementation folgt.
- **Wenn ein Test schwer zu schreiben ist** (unklare Erwartung, unklarer Port-Vertrag): Spec-Lücke oder Architektur-Frage → sofort Issue, kein "ich denk's mir aus".
- **Existierende Tests werden nach `wot-core-test-migration.md` in Buckets klassifiziert** — neue Tests landen direkt im richtigen Bucket, nicht in legacy-Verzeichnissen.
- **Keine Schreib-und-dann-Test-Sprints**: UltraCode darf nicht erst die ganze Workflow-Klasse implementieren und am Ende Tests nachziehen. Pro Use-Case ein Test-First-Loop.

## Spec-Härtung-Loop

`reference-implementation-refactor.md#spec-feedback-rule` gilt verbindlich. Wenn UltraCode auf Spec-Unklarheit stößt:

1. **Sofort Issue in `real-life-org/wot-spec`** mit Label `spec-conformance` / `architecture-decision`. Body: Spec-Stelle (Datei:Zeile), beobachtete Mehrdeutigkeit, 2-3 Resolution-Optionen mit Trade-offs.
2. **Im Code temporäre Wahl** + Kommentar `// SPEC-UNKLAR: real-life-org/wot-spec#NN` direkt an der Stelle.
3. **Im PR-Body** alle erzeugten Spec-Issues als Liste auflisten — als sichtbarer Spec-Härtungs-Output.

Verboten: Spec-Lücke mit lokalem Workaround dauerhaft auflösen.

## Phase-1 Definition of Done

**Verbindlich = 12-Punkte aus `legacy-boundary-map.md#legacy-purge-completion-criteria`**, ergänzt um drei Anforderungen aus der heutigen Diskussion:

13. **Standalone-Publikation**: `scripts/smoke-third-party-consumer.mjs` läuft grün in CI, `package.json` hat `exports`-Map, `README.md` dokumentiert Subpaths.
14. **Demo zu 100% via Hooks**: ESLint-Regel verhindert direkte `@web_of_trust/core`-Imports in Demo-UI außer in `hooks/wot/` und `runtime/`.
15. **COVERAGE.md neu generieren oder weglassen**: mechanischer Generator aus `wot-spec/conformance/manifest.json` + Code-Lokationen, ODER entfernt mit Hinweis auf `IMPLEMENTATION-ARCHITECTURE.md` als Lage-Karte.
16. **TDD-Spur pro Workflow nachweisbar**: für jeden neu geschriebenen oder verschobenen Workflow in 1.B existiert mindestens ein Application-Use-Case-Test, der commit-weise vor der Implementation liegt (Commit-History oder PR-Body weist die Reihenfolge aus). Adapter-Contract-Tests und Hook-Tests sind pro Workflow vorhanden. Reine Datei-Verschiebungen sind ausgenommen.

Plus Test/Build-Garantien:
- `pnpm --filter @web_of_trust/core test/typecheck/build` grün
- `pnpm --filter demo test/build` grün
- `npm run validate` in `wot-spec` grün

## Reihenfolge / Empfehlung für UltraCode-Sessions

Strikte Reihenfolge wegen Abhängigkeiten:

1. **1.A.1 Querschnitt-Konsolidierung ohne Crypto** zuerst — schafft die Schichten-Sauberkeit auf der 1.B aufbaut. ✅ in PR #153.
2. **1.B.1 Identity** kann parallel zu 1.A.2 starten (kein Crypto-Konflikt) — klein, schnell, gibt Vertrauen in den Flow.
3. **1.A.2 Crypto-Entkopplung** sobald Spec-Issues #95/#96/#97 beantwortet sind. Parallel zu 1.B.1 möglich.
4. **1.B.2 Trust** und **1.B.3 Sync** in der Reihenfolge (Trust hat weniger Querverbindungen). 1.B.3 hängt an 1.A.2 (`EncryptedSyncService`, `GroupKeyService` migrieren in 1.B.3 sauber, brauchen aber das aufgelöste crypto-Erbe).
5. **1.D Demo-Hooks** kann erst sauber laufen wenn 1.A.1+1.A.2 done und mind. 1.B.1+1.B.2 abgeschlossen sind.
6. **1.E Test-Migration** parallel zu 1.D.
7. **1.C Standalone-Publikation** ganz am Ende — finalisiert die öffentliche API.

## Nicht-Ziele

- Kein `packages/wot-react/`-Paket extrahieren (Phase 2 mit RLS).
- Kein RLS-/HMC-Extensions-Refactor (Phase 2/3).
- Kein UI-Redesign außer wo eine Komponente sowieso umgeschrieben werden muss.
- Keine DIDComm-Mediator-/JWE-Erweiterung außerhalb existierender Spec.
- Keine Mobile-Release-Pipeline-Änderungen (Phase 4).

## Operative Anmerkungen für UltraCode-Sessions

- **Output-Kontrakt vor `/effort ultracode`**: Session-Prompt verweist auf diese Datei + DoD-Punkte + Candidate-Nummern + den TDD-Block (§ TDD-Verbindlichkeit). Kein "improvise".
- **TDD-Reihenfolge ist verbindlich** für 1.B.* und 1.D. Test-First-Commits werden im PR-Body markiert. Details: § TDD-Verbindlichkeit.
- **Worktree-Isolation pro Sub-Phase**: 1.A in eigenem Worktree, 1.B.1 in anderem etc.
- **5-Punkte-Traceability-Block** (aus `reference-implementation/README.md`) im PR-Body Pflicht: Spec-Refs, Conformance-Profil, Implementation-Modul, Tests/Vektoren, Open Spec Questions.
- **Max-Iterationen mitgeben**: bei Nicht-Erreichen der Sub-Phase-DoD nach N Agenten-Iterationen → **stoppen statt brennen**.
- **Ein PR pro Sub-Phase**, Body verweist auf erreichte DoD-Punkte. Anton merged manuell.
- **Manager-Loop pausiert während UltraCode-Sessions** — Token-Konkurrenz vermeiden.
- **Kein Legacy-Workaround-Vokabular**: keine Aliase, Re-Export-Shims, Bridge-Module, Compatibility-Wrapper, `@deprecated`-Marker, Übergangs-Re-Exports oder "temporäre" Kompatibilitäts-Pfade. Der Authority-Model-Grundsatz aus `reference-implementation/README.md` ("Programm der Replacement, nicht Programm der Erweiterung") gilt strikt.
- **Wenn UltraCode während einer Session merkt, dass ein Legacy-Import einen Konsumenten brechen würde** (z.B. `wot-cli`, `wot-relay`, `wot-profiles`, `wot-vault` importiert noch direkt aus dem Legacy-Pfad), gilt strikte Priorisierung:
  1. **(b) Konsument mitmigrieren** — Standard. Scope wird erweitert um den brechenden Konsumenten; alle Imports auf die neue API umgestellt. Gilt für jeden Konsumenten innerhalb dieses Monorepos. Migration ist Teil der laufenden Session, nicht ein Folge-PR.
  2. **(c) Bewusste Ausnahme dokumentieren** — nur falls (b) den Session-Scope wirklich sprengt (z.B. ein externes Drittpaket außerhalb dieses Monorepos hängt davon ab). Ausnahme bekommt im PR-Body: Owner-Name, konkreter Begründung, Deletion-Date. Kein silent Shim.
  3. **(a) Hard stop** — Session stoppt, Anton entscheidet. Nur wenn (b) und (c) beide nicht greifen oder die Migrationsbreite eine fundamentale Architekturfrage aufwirft.
