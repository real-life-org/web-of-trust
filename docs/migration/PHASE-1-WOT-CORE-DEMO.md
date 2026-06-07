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

### 1.A.1.1 — `did.ts` Auflösung (Mini-Slice, Sessions ~0.5)

Resolution-Plan aus [wot-spec#97](https://github.com/real-life-org/wot-spec/issues/97#issuecomment-4642708927):

- `createDid`, `didToPublicKeyBytes` → ersatzlos löschen (existieren byte-identisch in `protocol/identity/did-key.ts`).
- `isValidDid` → ersatzlos löschen (tot in wot-core).
- `getDefaultDisplayName` → nach `application/identity/display-name.ts` verschieben (UX-Convention, kein normatives Protokoll).
- Konsumenten umbiegen, `src/crypto/did.ts` löschen.
- Demo-Inline-Fallback-Vereinheitlichung als separates Issue [#156](https://github.com/real-life-org/web-of-trust/issues/156) für 1.D.

Voraussetzung: 1.B.1 PR muss gemerged sein (vermeidet File-Konflikte in `application/identity/`).

### 1.A.2 — Crypto-Cleanup + Legacy-Marker (Sessions ~1, entsperrt)

> **Status 2026-06-07**: Alle drei Spec-Issues [#95](https://github.com/real-life-org/wot-spec/issues/95) (capabilities), [#96](https://github.com/real-life-org/wot-spec/issues/96) (envelope-auth), [#97](https://github.com/real-life-org/wot-spec/issues/97) (did.ts) sind beantwortet. **Kein Spec-Gate mehr.**

Die ursprüngliche Annahme (Port-Injection-Refactor + komplette `src/crypto/`-Entfernung) entfällt nach Spec-Klärung:

- **#95 capabilities.ts**: Nicht normativ. Move nach `application/authorization/capabilities.ts`. `AuthorizationAdapter`-Port wandert mit, weil er rein an Capability-Typen hängt. `protocol -/-> protocol-adapters`-Verstoß löst sich automatisch (in `application/` ist Adapter-Nutzung erlaubt).
- **#96 envelope-auth.ts**: Pipe-separiertes Top-Level-Signing widerspricht Sync 003 (Envelope = DIDComm-Plaintext, Authentizität via Inner-JWS im `body`). Legacy-Status. **Bleibt** in `src/crypto/` mit Legacy-Marker + Spec-Divergenz-Doku. Stirbt mit Automerge-Adapter-Stack-Refactor in Phase 2+.
- **#97 did.ts**: in 1.A.1.1 verortet.

**Konkrete Sub-Tasks für 1.A.2**:

1. `crypto/capabilities.ts` + Typen → `application/authorization/capabilities.ts` (Move + Konsumenten umbiegen).
2. `ports/AuthorizationAdapter.ts` → `application/authorization/AuthorizationService.ts` (Move; oder Name beibehalten als `AuthorizationAdapter` falls Refactor-Scope minimal halten gewünscht).
3. `crypto/encoding.ts` klassifizieren — vermutlich `protocol/crypto/` falls Funktionalität dort fehlt, sonst Demo-internal.
4. Legacy-Marker auf `crypto/envelope-auth.ts` + `types/messaging.MessageEnvelope` mit Spec-Divergenz-Doku + Phase-2-Verweis.
5. `crypto/index.ts` auf das Minimum reduzieren (nur envelope-auth-Re-Exports).
6. `types/messaging.MessageEnvelope` Legacy-Marker.

**Endzustand `src/crypto/` nach 1.A.1 + 1.A.1.1 + 1.A.2**:

```
src/crypto/
├── envelope-auth.ts    (Legacy-Marker + Spec-Divergenz-Doku, Phase-2-Sterben)
├── index.ts            (nur envelope-auth-Re-Export)
```

`./crypto`-Subpath in `exports`-Map bleibt zunächst (exportiert Legacy-MessageEnvelope-Operationen) mit `@deprecated`-Marker. Phase-2-Refactor des Automerge-Stacks entfernt finale Files.

**Keine TDD-Verbindlichkeit** in 1.A.2 — reine Moves + Klassifikation + Marker.

### 1.B — Per-Workflow-Slices (Sessions ~3, nach Spec-Profil)

#### 1.B.1 — `wot-identity@0.1` (klein, größtenteils erledigt)

- Candidate **#1** (Identity seed-vault contract hardening) — Legacy `SeedStorage` Direct-Internal-Source-Tests entfernen, `IdentityWorkflow` als alleiniger Recovery-Pfad, runtime-spezifische Non-Extractable-Handle-Doku.
- ADR 0001 Drei-Layer-Bar respektieren.

#### 1.B.2 — `wot-trust@0.1` (in zwei Sub-Slices aufgeteilt)

Während der Vorbereitung wurde klar: die zwei Candidates sind unterschiedlich groß und logisch unabhängig. Splitting hilft Review-Qualität und entkoppelt einen TDD-Refactor von einer surgical Entfernung.

##### 1.B.2-ack — `attestation-ack` entfernen (Candidate #4) — ✅ geliefert in PR #166

Trust 001 Z.147 + `CONFORMANCE.md` Z.69 sagen explizit: `wot-trust@0.1` definiert KEIN `attestation-ack` und keine semantische Annahmebestätigung. Konkret entfernt:

- Core `AttestationDeliveryService` (war Dead Code, 0 Real-Konsumenten)
- Message-Type `attestation-ack`
- `DeliveryStatus`-Wert `acknowledged`

**Was bewusst BLEIBT** (Stop-Bedingung aus Implementation gegriffen, Anton-bestätigt):

- **Sync 003 `ack/1.0` als Transport-Inbox-ACK** (Sync-Layer, normativ, getrennt vom Trust-Layer) — `DeliveryStatus: 'queued'/'sending'/'delivered'/'failed'` in Demo `AttestationService` plus Outbox/Retry/Receipt-Plumbing.
- **`accepted`-Flag als Publish-Consent** (nicht Trust-Akzeptanz): `setAttestationAccepted(id, accepted)`, AttestationList-Toggle, AdapterContext-Upload-Gating, Automerge-Schema-Feld. Steuert ausschließlich, ob eine empfangene Attestation in das öffentliche Profil des Holders aufgenommen wird. Das ist die **"Profil-Veröffentlichung als sichtbares Holder-Feedback"** als Application-Workflow, keine Trust-Wire-Semantik. Spec-Anker: Trust 001 Z.147/Z.149 + `CONFORMANCE.md` Z.69 (kein `attestation-ack`), und [wot-spec#21](https://github.com/real-life-org/wot-spec/issues/21) (closed: Klassifikation delivery receipts vs. attestation-ack).

> **Wichtige Klarstellung gegenüber älteren Plan-Versionen**: frühere Formulierungen wie "jede `accepted`-Modellierung wird entfernt" waren zu pauschal. `accepted` als Trust-Akzeptanzbestätigung (gibt es nicht) ≠ `accepted` als Publish-Consent (legitimes Produktfeature). Spec-Anker für die Trennung: Trust 001 Z.147/Z.149 + `CONFORMANCE.md` Z.69 + [wot-spec#21](https://github.com/real-life-org/wot-spec/issues/21)-Resolution.

##### 1.B.2-verification — Verification-Delivery-Workflow (Candidate #3) — deferred

Eigener Slice, **noch nicht umgesetzt**. Verlangt echten TDD-Refactor: `useVerification.ts` (~307 Zeilen) wird aufgeteilt in framework-freien Verification-Delivery-Workflow plus React-Hook über Application-Use-Case. Relay-Envelope-Konstruktion + Contact/Profile-Side-Effects wandern hinter den Workflow.

Voraussetzungen: 1.B.2-ack ✅. Kein Spec-Gate. Kann parallel zu 1.B.3 starten.

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

### 1.F — Spec-Conformance-Audit (Sessions ~2-3, kritisch)

> **Hinzugefügt 2026-06-07** nach Befund: Phase 1 hat bisher primär Architektur repariert (Schichten, Imports, Re-Exports), aber **Spec-Konformität nicht systematisch hergestellt**. Punktuell, wo es aufgefallen ist (z.B. `attestation-ack`-Entfernung in 1.B.2-ack), aber nicht systematisch durchgegangen. EncryptedSyncService gegen Sync 001 PR #83 ist das jüngste Beispiel — Spec PR seit 03.06. gemerged, ungeprüft trotz mehrerer dazwischen liegender Slices.

**Mission**: jede normative Spec-Section systematisch gegen den aktuellen Code-Stand auditieren. Output: Diff-Liste, klassifiziert nach Schwere und Slice-Verortung.

**Pflicht-Audit-Locations** (gegen `wot-spec/` Quelldateien):

```
wot-spec/01-wot-identity/001..004.md
wot-spec/02-wot-trust/001..002.md
wot-spec/03-wot-sync/001..006.md
wot-spec/CONFORMANCE.md
wot-spec/decisions/0001-identity-seed-protection-conformance-bar.md
wot-spec/test-vectors/phase-1-interop.json
```

**Audit-Methodik pro Spec-Section**:

1. Section vollständig lesen, MUSS-/SOLL-/DARF-NICHT-Regeln extrahieren.
2. Für jede Regel: zugehörige Code-Stelle(n) finden (grep nach Schlüsselbegriffen, Funktionsnamen, Wire-Formaten).
3. Klassifizieren:
   - **konform** (Regel ist im Code umgesetzt, Test-Vektor grün)
   - **drift** (Code weicht ab — Schwere: blocker / should-fix / minor)
   - **fehlt** (Regel ist im Code nicht abgedeckt)
   - **n/a** (Regel betrifft anderen Layer / Phase 2+)
4. Eintrag in Audit-Diff-Liste mit: Spec-Zitat, Code-Stelle, Klassifikation, Begründung, Slice-Verortung.

**Retroaktiver Sub-Task — vor systematischem Audit**:

Die bereits gemergten Slices (1.A.1, 1.A.1.1, 1.A.2, 1.B.1, 1.B.2-ack) werden retroaktiv geprüft. Nicht "war der Refactor strukturell sauber" — das wurde geprüft —, sondern: **ist der Code in dem Bereich, den der Refactor berührt hat, jetzt spec-konform**. Bereiche mit Drift gehen direkt in den 1.F-Backlog mit Slice-Verortungs-Vorschlag.

**Audit-Output-Artefakt**: `docs/migration/SPEC-AUDIT.md` mit der vollständigen Diff-Liste. Wird in 1.F-Sub-Slices implementiert (1.F.1 bis 1.F.N je nach Schwere/Größe der gefundenen Drifts).

**Voraussetzung für 1.D**: 1.F-Audit-Diff-Liste muss existieren und 1.F-Sub-Slices priorisiert sein. Demo-Hooks dürfen erst migriert werden, wenn die Workflows spec-konform sind, sonst migrieren wir Hooks auf nicht-konformen Workflow-Code.

**Voraussetzung für 1.C**: alle 1.F-Sub-Slices mit Klassifikation `blocker` müssen abgearbeitet sein. Standalone-Publikation darf keine spec-nicht-konforme Implementation als Referenz veröffentlichen.

**Realistische Größenordnung**: 2-3 Sessions Audit (parallelisierbar pro Spec-Familie: Identity, Trust, Sync). Plus 1.F.N-Sub-Slices je nach Drift-Befund.

### 1.E — Test-Migration (Sessions ~1)

- Nach `wot-core-test-migration.md`-Klassifikation jeden Test in seinen Bucket (`protocol` / `application` / `adapter` / `react` / `e2e`) bringen.
- **Migrations-Regel**: keine Legacy-Test-Löschung ohne äquivalenten Ersatz auf der korrekten Schicht.
- Endergebnis: keine Tests mehr in legacy-Verzeichnissen oder gemischten Buckets. Tests in `apps/demo/` analog klassifiziert.
- Kann parallel zu 1.D laufen.

## Spec-Lektüre-Verbindlichkeit (HÖCHSTE Priorität)

> **Anlass (2026-06-07)**: 1.B.3-Session-Befund zeigte: weder UltraCode noch Reviewer haben Sync 001 vollständig gelesen, obwohl die Frage (Nonce-Konstruktion für CRDT-Change-Crypto) dort normativ geklärt ist (Sync 001 Z.87 + Z.103-105, fixiert durch wot-spec PR #83). Statt die Klärung anzuwenden, wurde eine Optionsfrage formuliert ("Random behalten oder migrieren?") — auf einer Spec-Section, die keine Optionen hat, sondern MUSS-Regeln. Das ist die Wurzel jeder vermeidbaren Spec-Drift in Phase 1.

**Die Spec ist die normative Vorlage für die Referenzimplementierung. Nicht der bestehende Code.** Für jede Slice-Session und jede Implementations-Entscheidung gilt:

1. **Erst Spec lesen, dann implementieren.** Die in den verbindlichen Grundlagen aufgelisteten Spec-Files sind nicht "zur Orientierung", sondern verbindliche Anker. Für jede Sub-Task MUSS UltraCode die relevante Spec-Section vollständig lesen und das normative Zitat (Datei + Zeile + Originaltext) sammeln, **bevor** Code geschrieben wird oder eine Optionsfrage formuliert wird.

2. **Verboten: Optionsfragen zu normativ geklärten Themen.** Wenn die Spec MUSS-/SOLL-/DARF-NICHT-Regeln zur Frage enthält, gibt es keine Optionen — nur "wie wendet die Implementation die Regel an". Optionsfragen unter dieser Bedingung sind ein vermeidbarer Fehler (analog zur Doku-Sync-Should-Fix-Klassifikation).

3. **Verboten: Code-zuerst-Logik.** UltraCode darf nicht aus dem bestehenden Code rückwärts inferieren ("der Code macht X, also vermutlich richtig"). Der Code ist historisch ohne Spec entstanden (Memory: "Spec wurde NACH beiden Impls geschrieben") — er ist Audit-Subjekt, nicht Vorlage.

4. **Spec-Zitat-Output-Kontrakt**: PR-Body bekommt einen Pflicht-Block **"Spec-Anker pro Implementations-Entscheidung"**. Format pro Entscheidung:
   ```
   Entscheidung: <kurze Beschreibung>
   Spec-Zitat: wot-spec/<datei>:<zeile> — "<Originaltext>"
   Code-Anker: <pfad>:<zeile> — <was die Stelle tut>
   ```
   Leerer Block bedeutet: keine spec-relevanten Entscheidungen im Slice. Das ist erlaubt für reine Struktur-Slices, aber muss explizit benannt werden.

5. **Spec-Härtung-Loop bleibt nur für ECHTE Lücken**: ein Spec-Issue wird nur erstellt, wenn die Spec wirklich nicht spricht — nicht als Default-Reaktion auf Unsicherheit. Vor Issue-Erstellung MUSS UltraCode dokumentieren: "Ich habe Section X.Y vollständig gelesen, suche nach Begriff Z, finde keine Aussage" mit grep-Output als Beleg.

6. **Doppel-Audit-Verfahren**: Vor PR-Open prüft UltraCode den eigenen Code gegen den Spec-Zitat-Block. Nach PR-Open prüft Loop-Review die Spec-Zitate ebenfalls. Beide stellen sicher, dass die Implementation tatsächlich aus dem Zitat abgeleitet ist und nicht aus Code-Patterns.

Loop-Review-Should-Fix wegen Spec-Drift ist die schwerwiegendste Klassifikation — schwerer als Doku-Drift, weil sie die Referenzimplementierungs-Behauptung selbst untergräbt.

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

## Doku-Sync-Verbindlichkeit

> **Anlass**: drei aufeinanderfolgende Slice-PRs (1.A.1.1/#160, 1.A.2/#163, 1.B.2-ack/#166) bekamen Loop-Review-Should-Fix-Findings wegen veralteter Doku-Referenzen — jeweils mit Folge-Commit nachgepflegt. Das Pattern ist vermeidbar.

**Verbindlich für jede Slice-Session**: Vor PR-Open MUSS jedes umbenannte, verschobene oder gelöschte Modul/Symbol/Path gegen die folgenden Doku-Locations gegrept werden. Veraltete Referenzen sind entweder zu aktualisieren (wenn sie aktuellen Stand behaupten) oder als historisch zu markieren (mit Slice-Verweis, z.B. "removed in 1.A.1.1", "moved in 1.A.2").

**Pflicht-Grep-Locations**:

```
docs/CURRENT_IMPLEMENTATION.md
docs/GLOSSARY.md
docs/ROADMAP.md
docs/architecture/**.md
docs/flows/**.md
docs/security/**.md
docs/reference-implementation/**.md
docs/migration/**.md
packages/wot-core/src/protocol/COVERAGE.md
packages/wot-core/README.md   # ab Slice 1.C
```

**Was zählt als zu prüfender Change** (Beispiele):

- Datei verschoben/umbenannt → grep alten Pfad in allen Pflicht-Locations.
- Funktion/Klasse/Type gelöscht → grep Namen.
- Status-/Enum-Wert entfernt (z.B. `acknowledged`) → grep den Wert.
- Modul als `@deprecated` markiert → grep Modul-Namen, ergänze Deprecation-Hinweis in jeder aktuellen Erwähnung.

**Was nicht aufgeräumt werden muss**:

- Historische Migrations-Dokus (`docs/concepts/wot-rust-migration.md` etc.) die explizit damalige Zustände beschreiben — bleiben unverändert.
- Spec-Files (`wot-spec/`) — andere Repo-Verantwortung.

**Output-Kontrakt-Erweiterung**: PR-Body listet die durchgeführten Doku-Sync-Updates als eigenen Block (analog zur 5-Punkte-Traceability). Leerer Block bedeutet: nichts gefunden bei systematischer Grep-Suche, nicht: nicht gesucht.

**Loop-Review-Should-Fix wegen Doku-Drift gilt als vermeidbarer Fehler.** Aktuell aufgelaufene Folge-Commits (`32a9f62` nach PR #160, `20300ac` nach PR #163, `d7adc14` + `ebe8a95` nach PR #166) dokumentieren den Workflow; sollten in zukünftigen Slices nicht mehr nötig sein.

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
17. **`src/crypto/` minimal mit Legacy-Doku**: nach 1.A.1+1.A.1.1+1.A.2 enthält das Verzeichnis ausschließlich `envelope-auth.ts` + `index.ts` mit dokumentierter Spec-Divergenz (Verweis auf [wot-spec#96](https://github.com/real-life-org/wot-spec/issues/96) und Sync 003 Z.343/410) und Phase-2-Sterbe-Marker. Vollständige Löschung erbt Phase 2 (Automerge-Stack-Refactor).
18. **Spec-Conformance-Audit abgeschlossen** (§ 1.F): `docs/migration/SPEC-AUDIT.md` existiert mit vollständiger Diff-Liste, alle Drifts der Klassifikation `blocker` und `should-fix` sind in 1.F-Sub-Slices abgearbeitet, alle `minor`-Drifts haben eine dokumentierte Verortung (Phase 1.E oder Phase 2+).
19. **Spec-Zitat-Block in jedem Code-Slice-PR**: rückwirkend nicht erzwingbar für 1.A/1.B-merges, aber alle Slices ab 1.B.3-B3.1 müssen den Spec-Zitat-Output-Kontrakt erfüllen (siehe § Spec-Lektüre-Verbindlichkeit).

Plus Test/Build-Garantien:
- `pnpm --filter @web_of_trust/core test/typecheck/build` grün
- `pnpm --filter demo test/build` grün
- `npm run validate` in `wot-spec` grün

## Reihenfolge / Empfehlung für UltraCode-Sessions

Strikte Reihenfolge wegen Abhängigkeiten:

1. **1.A.1 / 1.A.1.1 / 1.A.2** ✅ in PR #153 / #160 / #163.
2. **1.B.1 Identity** ✅ in PR #158.
3. **1.B.2-ack** ✅ in PR #166. **1.B.3-B3.1** (Member-Key-Directory) abschließen, dann **STOP für Sync-Sub-Slices**.
4. **1.F Spec-Conformance-Audit** parallel zu B3.1-Abschluss starten — kritisch, blockiert ab hier 1.B.3-B3.2/B3.4/B3.5, 1.B.2-verification, 1.D.
5. **Retroaktiver Audit für 1.A.* + 1.B.1 + 1.B.2-ack** als erster 1.F-Sub-Task. Drift-Befunde gehen in den 1.F-Backlog.
6. **1.F-Sub-Slices (1.F.1..N)** abarbeiten — `blocker` zuerst, dann `should-fix`. Pro Sub-Slice eigener PR mit Spec-Zitat-Block.
7. **1.B.3-B3.2/B3.4/B3.5** (Sync-Workflows) und **1.B.2-verification** danach — beide mit zwingendem Spec-Zitat-Block, Spec-Lektüre-Verbindlichkeit + TDD-Verbindlichkeit + Doku-Sync-Verbindlichkeit gelten kumulativ.
8. **1.D Demo-Hooks** wenn 1.F + 1.B.* abgeschlossen sind. Verarbeitet auch Issues [#154](https://github.com/real-life-org/web-of-trust/issues/154), [#156](https://github.com/real-life-org/web-of-trust/issues/156).
9. **1.E Test-Migration** parallel zu 1.D, plus [#165](https://github.com/real-life-org/web-of-trust/issues/165) WotIdentity-Doku-Restbestand.
10. **1.C Standalone-Publikation** ganz am Ende — finalisiert die öffentliche API + [#154](https://github.com/real-life-org/web-of-trust/issues/154) + [#162](https://github.com/real-life-org/web-of-trust/issues/162) NodeNext-Fix.

**Wichtig**: ab 1.F gilt Spec-Konformität als oberster Audit-Maßstab. Strukturarbeit ist nur Vehikel, nicht Endzweck. Kein Slice schließt ohne Spec-Zitat-Block für jede Implementations-Entscheidung.

## Nicht-Ziele

- Kein `packages/wot-react/`-Paket extrahieren (Phase 2 mit RLS).
- Kein RLS-/HMC-Extensions-Refactor (Phase 2/3).
- Kein UI-Redesign außer wo eine Komponente sowieso umgeschrieben werden muss.
- Keine DIDComm-Mediator-/JWE-Erweiterung außerhalb existierender Spec.
- Keine Mobile-Release-Pipeline-Änderungen (Phase 4).

## Operative Anmerkungen für UltraCode-Sessions

- **Output-Kontrakt vor `/effort ultracode`**: Session-Prompt verweist auf diese Datei + DoD-Punkte + Candidate-Nummern + den **Spec-Lektüre-Block (§ Spec-Lektüre-Verbindlichkeit — HÖCHSTE Priorität)** + den TDD-Block (§ TDD-Verbindlichkeit) + den Doku-Sync-Block (§ Doku-Sync-Verbindlichkeit). Kein "improvise".
- **Spec-Lektüre vor jeder Implementations-Entscheidung verbindlich**. Optionsfragen zu normativ geklärten Themen sind verboten. Details: § Spec-Lektüre-Verbindlichkeit.
- **TDD-Reihenfolge ist verbindlich** für 1.B.* und 1.D. Test-First-Commits werden im PR-Body markiert. Details: § TDD-Verbindlichkeit.
- **Doku-Sync vor PR-Open ist verbindlich** für jede Slice-Session. Details: § Doku-Sync-Verbindlichkeit. Loop-Review-Should-Fix wegen Doku-Drift gilt als vermeidbar.
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
