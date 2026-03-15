# Offene Fragen & Entscheidungen

> Dokumentierte Entscheidungen und noch offene Punkte

## Getroffene Entscheidungen

### DID-Methode

| Frage | Entscheidung | Begründung |
|-------|--------------|------------|
| Eigene `did:wot` Methode? | **Nein, `did:key`** | Standard, selbstbeschreibend, kein Resolver nötig |

### Verschlüsselungsprotokoll

| Frage | Entscheidung | Begründung |
|-------|--------------|------------|
| Welches Protokoll für Gruppen? | **Item-Keys (POC)** | Einfach, bewährt, ausreichend für POC-Gruppengröße |

**Evaluierte Optionen:**

| Option | Pro | Con | Status |
|--------|-----|-----|--------|
| Item-Keys | Einfach, bewährt | O(N), keine FS | ✅ Gewählt für POC |
| MLS (RFC 9420) | Standard, FS+PCS | Server-Ordering nötig | Produktion denkbar |
| Keyhive/BeeKEM | Local-First native | Noch Forschung | Langfristig beobachten |

→ Siehe [Verschlüsselung](../protocols/verschluesselung.md)

### Sync-Protokoll

| Frage | Entscheidung | Begründung |
|-------|--------------|------------|
| Konkretes CRDT-Framework? | **Evolu (lokal), Automerge (cross-user)** | Evolu für Single-User-Speicher, Automerge für geteilte Spaces |
| Messaging-Protokoll? | **WebSocket Relay (POC), Matrix (Produktion)** | Matrix: Ed25519-kompatibel, Megolm-E2EE, Federation |
| Konfliktauflösung? | LWW (Last Writer Wins) | Einfach, deterministisch |

### Attestationen für ausgeblendete Kontakte

| Frage | Entscheidung | Begründung |
|-------|--------------|------------|
| Kann ich für ausgeblendete Kontakte attestieren? | **Ja** | Attestation = Aussage über Vergangenheit |

### Empfänger-Prinzip (Speicherort von Verifizierungen/Attestationen)

| Frage | Entscheidung | Begründung |
|-------|--------------|------------|
| Wo werden Verifizierungen/Attestationen gespeichert? | **Beim Empfänger (`to`)** | Datenhoheit, keine Schreibkonflikte |
| Kann der Empfänger Attestationen ausblenden? | **Ja (`hidden=true`)** | Kontrolle über eigenes Profil |
| Kann der Empfänger Verifizierungen ausblenden? | **Nein** | Steuern Kontakt-Status |

**Vorteile:**
- Empfänger kontrolliert, was über ihn veröffentlicht wird
- Keine CRDT-Konflikte (jeder schreibt nur bei sich)
- Attestationen können ausgeblendet, aber nicht gelöscht werden
- Sender speichert nur Public Keys (für E2E-Verschlüsselung)

**Konsequenzen:**
- Mein Profil zeigt, wer **mich** verifiziert hat (nicht wen ich verifiziert habe)
- Attestationen werden als "Geschenk" empfangen und beim Empfänger gespeichert
- Hidden-Flag nur für Attestationen (Verifizierungen steuern Kontakt-Status)

### Recovery-Phrase

| Frage | Entscheidung | Begründung |
|-------|--------------|------------|
| Quiz bei Onboarding? | **Ja, Pflicht** | Absicherung gegen "nicht notiert" |
| Phrase später anzeigen? | **Nein** | Sicherheitsrisiko |

### Gruppen-Verwaltung

| Frage | Entscheidung | Begründung |
|-------|--------------|------------|
| Admin-Modell oder Quorum? | **Admin-Modell** | Einfacher, CRDT-kompatibel |
| Was wenn Admin weg? | **Multi-Admin empfehlen** | UI-Warnung bei nur 1 Admin |

**Admin-Rechte:**
- Mitglieder einladen/entfernen
- Gruppe umbenennen
- Andere zu Admins machen
- Module aktivieren/deaktivieren

**Später:** Quorum-basiertes Modell als Alternative → [Quorum-Konzept](quorum-konzept.md)

### Offline-Verifizierung

| Frage | Entscheidung | Begründung |
|-------|--------------|------------|
| Offline-Verifizierung möglich? | **Ja** | Durch Offline-First-Architektur bereits abgedeckt |

Ablauf:
1. QR-Code scannen (braucht kein Netz)
2. Verification lokal signieren und speichern
3. Bei nächster Verbindung: Sync zum Server
4. Kontakt wird "active" sobald beide Verifications synchronisiert

---

## Offene Fragen

### Technisch

| Frage | Kontext | Vorschlag |
|-------|---------|-----------|
| Multi-Device ohne Recovery? | Nutzer will 2. Gerät ohne Phrase eintippen | **Vorerst nein** - Key-Schutz hat Priorität |
| Wo liegen öffentliche Profile? | Abruf von Profilen per DID | **Tendenz:** Sync-Server; föderiert nicht ausgeschlossen |

### Konzeptionell

| Frage | Kontext | Status |
|-------|---------|--------|
| Negative Attestationen? | "Diese Person ist unzuverlässig" | **Vorerst nein** - zu komplexe Dynamik |
| Selbst-Attestationen? | "Ich kann Fahrräder reparieren" | **Denkbar** - aber weniger Vertrauen |
| Gruppen-Attestationen? | Gruppe attestiert gemeinsam | **Offen** |

### UX

| Frage | Kontext | Status |
|-------|---------|--------|
| Onboarding ohne Verifizierung | Nutzer will App erstmal testen | Erster Kontakt kann manuell sein? |
| Recovery-Quiz zu schwer? | Greta (70+) | Vereinfachte Variante? |

---

## Bekannte Limitierungen

### Systembedingt

| Limitierung | Begründung |
|-------------|------------|
| Keine anonyme Nutzung | Verifizierung = jemand kennt dich |
| Metadaten sichtbar für Server | Trade-off für Usability |
| Keine Löschung von Verifizierungen | Immutability by design |

### Aktuell nicht geplant

| Feature | Grund |
|---------|-------|
| Gruppen-Chat | Fokus auf Attestationen, nicht Messaging |
| Öffentliche Profile | Fokus auf lokale Gemeinschaften |
| Bezahlfunktionen | Außerhalb des Scope |

---

## Entscheidungslog

### 2026-02-08

1. **6-Adapter-Architektur v2**: Storage, ReactiveStorage, Crypto + Messaging, Replication, Authorization
2. **CRDT-Framework**: Evolu (lokal, Single-User) + Automerge (cross-user Spaces)
3. **Messaging**: WebSocket Relay (POC), Matrix (Produktion)
4. **Verschlüsselung**: Item-Keys für POC
5. **Framework-Evaluation**: 16 Frameworks evaluiert, 6 eliminiert → [Ergebnis](../protocols/framework-evaluation.md)

### 2025-02-02

1. **Empfänger-Prinzip**: Verifizierungen und Attestationen werden beim Empfänger (`to`) gespeichert
2. **Attestationen ausblendbar**: Empfänger kann `hidden=true` setzen (aber nicht löschen)
3. **Verifizierungen nicht ausblendbar**: Steuern Kontakt-Status
4. **Kontakt-Status vereinfacht**: Nur `pending` und `active` (Ausblenden via Auto-Gruppe `excludedMembers`)

### 2025-01-08

1. **DID-Methode**: `did:key` statt eigener `did:wot`
2. **Verschlüsselung**: Abstrakt halten, Optionen dokumentieren
3. **Sync**: CRDT-basiert, Framework offen
4. **Attestationen**: Auch für ausgeblendete Kontakte erlaubt
5. **Recovery-Quiz**: Pflicht bei Onboarding

---

## Nächste Schritte

### Vor Implementierung zu klären

1. ~~CRDT-Framework wählen~~ → Evolu (lokal) + Automerge (cross-user)
2. ~~Verschlüsselungsprotokoll~~ → Item-Keys für POC
3. Server-Architektur (self-hosted vs. managed)

### Zu validieren mit Nutzern

1. Recovery-Quiz Usability (besonders ältere Nutzer)
2. Onboarding ohne ersten Kontakt
3. Gruppen-Verwaltung Komplexität
