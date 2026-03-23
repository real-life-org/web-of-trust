---
title: Die Web-of-Trust Demo ausprobieren
description: Erstelle deine dezentrale Identität, verifiziere Kontakte und tausche Attestierungen aus — alles direkt im Browser.
date: 2026-02-09
author: Anton Tranelis
---

# Die Web-of-Trust Demo ausprobieren

*9. Februar 2026 — Anton Tranelis*

Web of Trust ist ein dezentrales Vertrauensnetzwerk. Statt einer zentralen Plattform, der du vertrauen musst, baust du dir dein eigenes Netz aus persönlich verifizierten Kontakten auf. Deine Daten bleiben verschlüsselt auf deinem Gerät.

Die Demo zeigt die Kernfunktionen: Identität erstellen, Kontakte verifizieren, Attestierungen austauschen. Alles läuft im Browser — kein Account, kein Server, der deine Daten sieht.

## Identität erstellen

Wenn du die [Demo](/demo) zum ersten Mal öffnest, wirst du durch die Erstellung deiner Identität geführt:

1. **12 Magische Wörter** werden generiert — das ist dein Backup-Schlüssel. Schreibe sie auf und bewahre sie sicher auf.
2. **Überprüfung** — Du bestätigst drei zufällige Wörter, damit sicher ist, dass du sie notiert hast.
3. **Profil** — Wähle einen Namen und optional ein Profilbild.
4. **Passwort** — Schützt deine Identität auf diesem Gerät.

Technisch passiert dabei: Aus den 12 Wörtern (BIP39) wird ein kryptographischer Schlüssel abgeleitet (Ed25519). Daraus entsteht deine DID (Decentralized Identifier) — eine weltweit eindeutige Adresse, die nur du kontrollierst. Mehr dazu im [technischen Design-Artikel](/blog/technisches-design).

## Kontakte verifizieren

Das Herzstück von Web of Trust ist die persönliche Verifizierung. Du bestätigst, dass du eine reale Person getroffen hast — nicht nur ein Profil im Internet.

**Zum Testen:** Öffne die Demo in zwei Browser-Tabs (oder auf zwei Geräten). Erstelle in jedem Tab eine eigene Identität.

1. **Tab 1:** Gehe zu "Verifizieren" und starte eine neue Verifizierung. Ein Code wird angezeigt.
2. **Tab 2:** Gehe ebenfalls zu "Verifizieren", wähle "Code eingeben" und füge den Code aus Tab 1 ein. Ein Antwort-Code wird generiert.
3. **Tab 1:** Gib den Antwort-Code ein und schließe die Verifizierung ab.

Beide Identitäten sind jetzt gegenseitig verifiziert und erscheinen als Kontakte.

## Attestierungen

Nach der Verifizierung kannst du Attestierungen erstellen — das sind signierte Aussagen über deine Kontakte:

1. Gehe zu "Attestierungen" → "Neue Attestierung"
2. Wähle einen verifizierten Kontakt
3. Schreibe eine Aussage (z.B. "Hat mir bei der Gartenarbeit geholfen")
4. Die Attestierung wird signiert und über den Relay an den Kontakt gesendet

Der Empfänger sieht die Attestierung unter "Erhalten" und kann sie annehmen oder ablehnen.

## Wie die Daten gespeichert werden

Alle Daten liegen lokal in deinem Browser:

- **Identität:** Verschlüsselt in IndexedDB
- **Kontakte & Attestierungen:** In einer lokalen CRDT-Datenbank (Evolu)
- **Messaging:** Ein WebSocket Relay leitet verschlüsselte Nachrichten weiter — der Relay kann den Inhalt nicht lesen

Wenn du den Browser schließt und wieder öffnest, sind deine Daten noch da. Du kannst deine Identität mit den 12 Magischen Wörtern auch auf einem anderen Gerät wiederherstellen.

## Was kommt als nächstes?

Die Demo zeigt das Fundament. Darauf bauen wir auf:

- **Profil-Sync** über CRDTs (damit dein Name auf allen Geräten gleich ist)
- **Gruppen-Räume** für gemeinschaftliche Zusammenarbeit
- **Mehr Attestierungstypen** (Fähigkeiten, Empfehlungen, Rollen)
- **Federation** über Matrix (damit verschiedene Communities sich verbinden können)

Wer verstehen will, wie das alles technisch zusammenspielt — von der Kryptographie über die Adapter-Architektur bis zum Relay — findet die Details im [technischen Design-Artikel](/blog/technisches-design).

[Probier die Demo aus →](/demo)
