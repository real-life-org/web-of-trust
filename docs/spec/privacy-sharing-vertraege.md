# Privacy- und Sharing-Verträge (P-Verträge)

Status: **Diskussionsentwurf** — Produktentscheidung bei Anton.
Gilt für die WoT Demo App und den RLS-Connector gleichermaßen (ein Vertragssatz, zwei Implementierungen).

## Motivation

Store-Readiness (Play Store / App Store) verlangt ein belastbares Consent-Modell. Heute publiziert
die App Profile und Verifikationen ungefragt auf den Profiles-Server. Das ist ein Blocker.

## Anker-Prinzip

> **Die Verifikations-Beziehung ist die Vertrauensgrenze.**
> Wem ich von Angesicht zu Angesicht die Identität bestätigt habe, dem vertraue ich meine Daten an.
> Innerhalb des Kontakt-Netzwerks wird per Default geteilt — verschlüsselt, Ende-zu-Ende.
> Der öffentliche Server bekommt Daten **nur** durch eine explizite, bewusste Nutzeraktion.

Entschieden von Anton am 18.07.2026: „Wir vertrauen unseren Kontakten, deshalb teilen wir per
default Verifikationen im Netzwerk."

## Verträge

**P1 — Keine stille Veröffentlichung.** Kein Datum (Profil, Verifikation, Avatar) erreicht den
öffentlichen Profiles-Server ohne eine explizite, auf dieses Datum bezogene Nutzeraktion.
App-Start, Onboarding, Profil-Speichern und Verifikation lösen KEINE Server-Publikation aus.

**P2 — Default-Sharing im Kontakt-Netzwerk.** Profil-Updates und eigene Verifikationen werden per
Default mit allen verifizierten Kontakten geteilt — verschlüsselt über die inbox/1.0-Familie, nie
über den öffentlichen Server. Der Nutzer kann das Teilen abschalten (Setting), der Default ist AN.

**P3 — Depublizieren wirkt.** Widerruft der Nutzer eine Veröffentlichung, entfernt der Server das
Datum. Bereits an Kontakte geteilte Daten sind nicht rückholbar (ehrliche Semantik: Teilen ist wie
Erzählen), aber ein `verification-revoke` signalisiert Kontakten den Widerruf.

**P4 — Zustellbarkeit ohne Server-Profil.** Verschlüsselte Zustellung an einen Kontakt hängt nicht
vom Server-Profil ab: Der Encryption-Key kommt aus dem Trust-002-QR-Austausch und wird pro Kontakt
lokal persistiert. Server-Lookup ist nur Fallback.

**P5 — Ego-zentrierter Graph.** Der Beamer-/Netzwerk-Graph speist sich aus lokal empfangenen
Verifikations-VCs (eigene + von Kontakten geteilte, 2 Hops), nicht aus öffentlichen
Server-Records. Der Renderer bleibt unverändert; nur die Quelle von `useGraphCache` wechselt.

**P6 — Bestandsdaten-Bereinigung.** *(Vorschlag, abgeleitet aus P1)* Beim Rollout werden alle ohne
Consent publizierten Server-Records einmalig depubliziert. Der Graph überlebt das über P2/P5 —
die Daten leben weiter im Kontakt-Netzwerk. Wer öffentlich sichtbar sein will, publiziert danach
explizit neu.

**Consent-Granularität** *(Vorschlag)*: Server-Publikation ist **pro Ressource** explizit (Profil
veröffentlichen; einzelne Verifikation veröffentlichen), kein globaler „öffentlich"-Schalter.
Das passt zum bestehenden Publish-Dialog und hält die Entscheidung dort, wo das Datum entsteht.

## Transport (Option 1: Relay-Messages über inbox/1.0)

Drei neue Message-Kinds, gleiche Wire wie Attestations (ECIES + Inner-JWS):

| Kind | Inhalt | Semantik |
|---|---|---|
| `profile-update` | Profil (name, bio, avatar) + version | LWW über bestehende version; idempotent |
| `verification-share` | Batch von Verifikations-VC-JWS | additiv, jti-idempotent; Initial-Batch nach gegenseitiger Verifikation, danach inkrementell |
| `verification-revoke` | signiertes Widerrufs-Event (jti-Referenz) | Empfänger entfernt VC aus Graph-Quelle |

Zustellung läuft über die durable Work-Queue (Retry/Backoff wie attestation-delivery).
Pairwise-Spaces (CRDT pro Verbindung) sind eine spätere Evolution, wenn 1:1-Chat kommt — die VCs
sind portabel, Migration ist billig.

## Slices

- **A — Demo-App:** Auto-Publish entfernen, `profile-update`/`verification-share`/`verification-revoke`
  über inbox, Consent-UI für explizites Publizieren, Enc-Key-Persistenz pro Kontakt, Graph-Quelle
  umstellen, Bestands-Depublish (P6).
- **B — Connector:** gleiche Verträge; das Auto-Publish aus #143 (`updateProfile` → publishProfile)
  wird wieder entfernt bzw. hinter explizite Aktion gelegt.
- **C — Store-Compliance-Rest:** Privacy Policy, Data-Safety-Formular, Account-Löschung.

Prozess: TDD — P-Verträge werden erst als rote Vertragstests committed, dann implementiert.
