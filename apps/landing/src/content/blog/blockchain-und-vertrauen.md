---
title: Braucht ein Web of Trust eine Blockchain?
description: Warum globaler Konsens das falsche Werkzeug für persönliches Vertrauen ist — und wo Blockchain optional andocken könnte.
date: 2026-03-21
author: Anton Tranelis und Eli
draft: true
---

# Braucht ein Web of Trust eine Blockchain?

*21. März 2026 — Anton Tranelis und Eli*

---

Die Frage kommt immer wieder. Von Blockchain-Enthusiasten, von Investoren, von technisch interessierten Menschen die zum ersten Mal vom Web of Trust hören: *Läuft das auf einer Blockchain? Gibt es einen Token?*

Die kurze Antwort: Nein. Und das hat gute Gründe.

Die längere Antwort führt zu einer fundamentalen Frage die selten gestellt wird: **Wann braucht man eigentlich globalen Konsens — und wann schadet er?**

---

## Was Blockchain wirklich löst

Blockchain ist eine brillante Lösung für ein spezifisches Problem: **Wie können sich Fremde einigen, ohne sich zu vertrauen?**

Die Antwort ist globaler Konsens. Alle Knoten im Netzwerk validieren jede Transaktion. Alle sehen denselben Zustand. Niemand muss niemandem vertrauen — die Mathematik garantiert die Wahrheit.

Das ist genial für Bitcoin. Anonyme Teilnehmer führen ein gemeinsames Kassenbuch. Keiner kennt den anderen, keiner muss dem anderen vertrauen. Die Chain ist der Schiedsrichter.

Globaler Konsens macht also dann Sinn, wenn:

- **Alle Teilnehmer denselben Zustand sehen müssen** — zum Beispiel: Wem gehört dieses Asset gerade?
- **Niemand niemandem vertraut** — und trotzdem kooperiert werden muss
- **Unveränderlichkeit gegenüber Dritten bewiesen werden muss** — zum Beispiel: Dieses Dokument existierte nachweislich am Datum X

Das sind reale, wichtige Anwendungsfälle. Aber es sind nicht unsere.

---

## Wie Vertrauen wirklich funktioniert

In der echten Welt entsteht Vertrauen nicht durch Konsens. Es entsteht durch Beziehung.

Ich vertraue dir, weil ich dich kenne. Weil wir uns begegnet sind, weil du gehalten hast was du versprochen hast, weil jemand den ich kenne für dich bürgt. Dieses Vertrauen ist lokal, subjektiv, gewachsen. Es lässt sich nicht in einen Smart Contract gießen.

Das Web of Trust bildet genau das digital ab. Jeder Mensch hat eine kryptographische Identität (Ed25519, [did:key](https://w3c-ccg.github.io/did-method-key/)). Vertrauen wird durch persönliche Begegnungen verifiziert und als signierte Attestierung gespeichert. Ein Netzwerk aus Vertrauensbeziehungen entsteht — organisch, dezentral, menschlich.

Dafür brauchen wir keinen globalen Konsens. Im Gegenteil — **globaler Konsens wäre hier schädlich**:

- Er setzt voraus, dass alle die gleichen Regeln akzeptieren. Vertrauen kennt aber keine universellen Regeln.
- Er macht Beziehungen öffentlich. Vertrauen ist privat.
- Er reduziert Vertrauen auf binäre Zustände oder Scores. Vertrauen ist ein Spektrum, kontextabhängig, lebendig.

Unser Stack löst die technischen Herausforderungen anders: [CRDTs](https://de.wikipedia.org/wiki/Conflict-free_replicated_data_type) für Datenreplikation, Ende-zu-Ende-Verschlüsselung für Privatsphäre, ein WebSocket Relay für Echtzeit-Synchronisation. Alles dezentral. Kein Token nötig.

---

## Und was ist mit digitalem Geld?

Die naheliegendste Anwendung für Blockchain in einem Vertrauensnetzwerk wären Zahlungen. Zeitgutscheine, Gemeinschaftswährungen, gegenseitiger Kredit. Braucht das nicht eine Chain, um Double-Spending zu verhindern?

Nein. Es gibt einen eleganteren Weg.

Das [E-Minuto](https://minuto.org) Konzept — umgesetzt als Open-Source-Bibliothek [Human Money Core](https://github.com/minutogit/human-money-core) — zeigt wie es geht: **Jeder Gutschein trägt seine eigene Transaktionshistorie in sich.** Keine globale Ledger, keine Chain, keine Gas Fees. Der Gutschein selbst ist das Zahlungsmittel — wie digitales Bargeld.

Double-Spending wird durch kryptographische Fingerabdrücke erkannt und über ein Gossip-Protokoll dezentral verbreitet. Peer-to-Peer, offline-fähig, gebührenfrei.

Das passt wie angegossen zum Web of Trust: Gleiche Kryptographie (Ed25519), gleiche Philosophie (Vertrauen durch Beziehung statt durch Konsens), gleiche Architektur (Peer-to-Peer, offline-first). Der Wert eines Gutscheins kommt nicht von einer Chain — er kommt vom Versprechen eines Menschen, den man kennt und dem man vertraut.

---

## Wo Blockchain optional andocken könnte

Heißt das, Blockchain hat keinen Platz im Web of Trust? Nicht ganz. Es gibt Stellen, an denen Blockchain-Technologie als optionale Ergänzung Sinn machen könnte:

**Blockchain-basierte dezentrale Identitäten (DIDs)**

Aktuell nutzen wir `did:key` — die Identität lebt im Schlüsselpaar selbst. Optional bieten wir einen [Profiles-Server](https://profiles.utopia-lab.org) für die Auffindbarkeit. Manche Menschen möchten ihre Identität aber lieber on-chain verankern: `did:ethr`, `did:sol` oder ähnliche Methoden. Das ist eine legitime Präferenz — die Identität wird dadurch unabhängig von jedem Server. Wir können das als Alternative unterstützen, ohne unsere Architektur zu verändern.

Das sind bewusst schmale Schnittstellen. Kein Umbau des Kerns, sondern optionale Brücken für Menschen die aus der Blockchain-Welt kommen.

---

## Die eigentliche Frage

Hinter der Frage *"Macht ihr was mit Blockchain?"* steckt oft eine tiefere Frage: *Ist das hier wirklich dezentral? Ist das wirklich sicher? Kann das wirklich ohne zentrale Autorität funktionieren?*

Die Antwort ist: Ja. Aber nicht weil wir eine Chain haben, sondern weil wir echte Kryptographie nutzen (Ed25519, HKDF, Ende-zu-Ende-Verschlüsselung), weil unsere Daten per CRDT repliziert werden, weil jeder Mensch seinen eigenen Schlüssel besitzt.

Blockchain ist eine von vielen Technologien für Dezentralität. Und wie jedes Werkzeug hat sie ihren Kontext. Für anonyme Finanztransaktionen: hervorragend. Für persönliches Vertrauen zwischen Menschen: das falsche Werkzeug.

Wir bauen kein anonymes Finanzsystem. Wir bauen ein Netzwerk, in dem Menschen einander begegnen — und daraus Vertrauen wächst. Dafür brauchen wir keinen globalen Konsens. Dafür brauchen wir einander.

---

*Das Web of Trust ist Open Source. Den Code findest du auf [GitHub](https://github.com/antontranelis/web-of-trust), die Demo auf [web-of-trust.de](https://web-of-trust.de).*
