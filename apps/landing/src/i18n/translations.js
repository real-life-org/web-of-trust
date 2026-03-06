export const translations = {
  de: {
    // Header
    nav: {
      concept: 'Konzept',
      howItWorks: 'So funktioniert\'s',
      apps: 'Apps',
      personas: 'Für wen?',
      faq: 'FAQ',
      blog: 'Blog',
    },

    // Hero
    hero: {
      badge: 'Open Source Forschungsprojekt',
      titleStart: 'Vertrauen durch',
      titleHighlight: 'echte Begegnungen',
      subtitle: 'Ein dezentrales Vertrauensnetzwerk für lokale Gemeinschaften mit Werkzeugen zur selbstorganisierten Zusammenarbeit in dem Daten nur verschlüsselt mit Freunden und Gruppen geteilt werden.',
      cta: 'Mehr erfahren',
      demo: 'Demo ausprobieren',
      github: 'Auf GitHub ansehen',
      features: {
        verification: 'Persönliche Verifizierung',
        encrypted: 'Ende-zu-Ende verschlüsselt',
        offline: 'Funktioniert offline',
      },
    },

    // ProblemSolution
    problemSolution: {
      title: 'Ein anderer Ansatz',
      subtitle: 'Wir setzen auf lokale Gemeinschaften statt globaler Plattformen. Statt Algorithmen bauen wir auf echte Begegnungen.',
      today: 'Heute',
      better: 'Besser',
      problems: [
        { before: 'Social Media bindet Aufmerksamkeit', after: 'Im echten Leben verbinden' },
        { before: 'Deine Daten liegen bei Konzernen', after: 'Deine Daten liegen bei dir' },
        { before: 'Vertrauen durch Likes und Sterne', after: 'Vertrauen durch echte Begegnungen' },
        { before: 'Account-Erstellung alleine am Bildschirm', after: 'Onboarding durch Freunde in einer Kette' },
        { before: 'Abhängig von Servern und Empfang', after: 'Funktioniert auch ohne Internet' },
      ],
      pillarsTitle: 'Die drei Säulen',
      pillars: [
        {
          title: 'Verifizieren',
          description: 'Identität durch persönliches Treffen bestätigen',
          detail: 'Jede Beziehung beginnt mit einer echten Begegnung. Durch QR-Code-Scan bestätigst du: "Das ist wirklich diese Person."',
        },
        {
          title: 'Kooperieren',
          description: 'Verschlüsselte Inhalte teilen',
          detail: 'Teile Kalender, Orte und Projekte mit deinem Netzwerk. Alles Ende-zu-Ende verschlüsselt.',
        },
        {
          title: 'Attestieren',
          description: 'Reputation durch echte Taten aufbauen',
          detail: 'Bestätige was andere getan haben. Diese Attestationen bauen über Zeit sichtbares Vertrauen auf.',
        },
      ],
      note: {
        title: 'Verifizieren ≠ Vertrauen',
        text: 'Die Verifizierung bestätigt nur: "Das ist wirklich diese Person." Das eigentliche Vertrauen entsteht durch Attestationen über Zeit.',
      },
    },

    // HowItWorks
    howItWorks: {
      title: "So funktioniert's",
      subtitle: 'Vom ersten Treffen bis zur ersten Attestation - der Weg ins Netzwerk.',
      step: 'Schritt',
      steps: [
        {
          title: 'QR-Code scannen',
          description: 'Anna und Ben treffen sich. Ben scannt Annas QR-Code mit der App.',
          detail: 'Der QR-Code enthält Annas öffentlichen Schlüssel. Bens App erstellt automatisch seine eigene Identität.',
        },
        {
          title: 'Identität bestätigen',
          description: 'Ben bestätigt: "Ich habe Anna persönlich getroffen."',
          detail: 'Diese Verifizierung wird kryptographisch signiert und gleichzeitig werden Schlüssel getauscht.',
        },
        {
          title: 'Content sehen',
          description: 'Ben kann jetzt Annas geteilte Inhalte sehen.',
          detail: 'Kalender, Karten-Markierungen, Projekte - alles was Anna mit ihren Kontakten teilt, wird für Ben entschlüsselbar.',
        },
        {
          title: 'Attestation erstellen',
          description: 'Nach gemeinsamer Arbeit: Anna attestiert Bens Hilfe.',
          detail: '"Ben hat 3 Stunden im Garten geholfen" - diese signierte Aussage wird Teil von Bens Profil.',
        },
      ],
      result: {
        title: 'Das Ergebnis',
        text: 'Ein wachsendes Netzwerk aus echten Beziehungen. Jede Verbindung basiert auf einer persönlichen Begegnung. Jede Attestation auf einer echten Tat.',
      },
    },

    // Apps
    apps: {
      title: 'Was du damit machen kannst',
      subtitle: 'Web of Trust ist die Vertrauensebene. Darauf bauen verschiedene Apps auf, die lokale Zusammenarbeit ermöglichen.',
      items: [
        {
          title: 'Karte',
          description: 'Finde Menschen, Orte und Angebote in deiner Nähe. Sieh wer was kann und wo.',
        },
        {
          title: 'Kalender',
          description: 'Plane gemeinsame Aktionen, koordiniere Termine und lade zu Events ein.',
        },
        {
          title: 'Marktplatz',
          description: 'Teile Angebote und Gesuche. Tausche Ressourcen mit Menschen denen du vertraust.',
        },
        {
          title: 'Wertschätzung',
          description: 'Sag Danke mit digitalen Gutscheinen. Verschenke Zeit, Hilfe oder ein Dankeschön.',
        },
      ],
      note: {
        prefix: 'Alle Apps basieren auf',
        suffix: '– einem modularen Open-Source-Baukasten für lokale Vernetzung.',
      },
    },

    // Personas
    personas: {
      title: 'Für wen ist das Web of Trust?',
      subtitle: 'Menschen aus lokalen Gemeinschaften, die echte Verbindungen aufbauen wollen.',
      needsLabel: 'Bedürfnisse',
      howItHelpsLabel: 'Wie Web of Trust hilft',
      items: [
        {
          name: 'Hanna (62)',
          role: 'Die Gärtnerin',
          background: 'Aktiv im Gemeinschaftsgarten, nicht technikaffin, nutzt hauptsächlich WhatsApp.',
          needs: [
            'Wissen wer wann gießt',
            'Neue Helfer finden',
            'Sich nicht mit Technik beschäftigen müssen',
          ],
          howItHelps: 'Ihr Nachbar Tom richtet die App ein und verifiziert sie. Sie sieht den Gartenkalender und kann mit einem Tipp "Danke" sagen - das wird zur Attestation.',
        },
        {
          name: 'Alexander (34)',
          role: 'Der Macher',
          background: 'Kann alles reparieren, kennt viele Leute, organisiert Nachbarschaftshilfe.',
          needs: [
            'Überblick wer was kann',
            'Anfragen koordinieren',
            'Kein WhatsApp-Gruppen-Chaos',
          ],
          howItHelps: 'Verifiziert aktiv neue Leute bei Treffen. Erstellt Attestationen: "Kann Fahrräder", "Kann Elektrik". Sieht auf der Karte wer was anbietet.',
        },
        {
          name: 'Lena (28)',
          role: 'Die Skeptikerin',
          background: 'Softwareentwicklerin, Privacy-bewusst, hat schon viele "dezentrale" Projekte scheitern sehen.',
          needs: [
            'Verstehen wie es technisch funktioniert',
            'Sicher sein dass Daten verschlüsselt sind',
            'Kein Vendor-Lock-in',
          ],
          howItHelps: 'Open Source - kann den Code prüfen. E2E-Verschlüsselung mit lokalen Schlüsseln. Alle Daten exportierbar.',
        },
        {
          name: 'Familie Kowalski',
          role: 'Die Neuzugezogenen',
          background: 'Neu in der Stadt, kennen niemanden, wollen Anschluss finden.',
          needs: [
            'Nachbarn kennenlernen',
            'Vertrauenswürdige Angebote finden',
            'Teil einer Gemeinschaft werden',
          ],
          howItHelps: 'Beim Straßenfest erste Verifizierungen. Sehen sofort wer schon Attestationen hat. Können selbst Attestationen sammeln.',
        },
      ],
      note: 'Das Netzwerk wächst nur durch echte Begegnungen - das dauert, aber das ist der Punkt. Keine Masseneinladungen, keine Fake-Accounts.',
    },

    // Principles
    principles: {
      title: 'Die Prinzipien',
      subtitle: 'Was das Web of Trust ausmacht - und was es bewusst nicht ist.',
      items: [
        {
          title: 'Daten bei dir',
          description: 'Alle deine Daten liegen verschlüsselt auf deinem Gerät. Nur Leute die du verifiziert hast können sie entschlüsseln.',
        },
        {
          title: 'Echte Begegnungen',
          description: 'Jede Beziehung im Netzwerk basiert auf einer persönlichen Begegnung. Das verhindert Fake-Accounts und Spam.',
        },
        {
          title: 'Funktioniert offline',
          description: 'Content erstellen, Leute verifizieren, Attestationen vergeben - alles geht auch ohne Internet. Sync erfolgt später.',
        },
        {
          title: 'Open Source',
          description: 'Der gesamte Code ist öffentlich. Du kannst prüfen wie es funktioniert und sogar selbst beitragen.',
        },
        {
          title: 'Du hast den Schlüssel',
          description: 'Deine kryptographische Identität gehört dir. Mit der Recovery-Phrase kannst du sie jederzeit wiederherstellen.',
        },
        {
          title: 'Daten exportierbar',
          description: 'Kein Vendor-Lock-in. Du kannst alle deine Daten jederzeit exportieren und mitnehmen.',
        },
      ],
      notTitle: {
        prefix: 'Was Web of Trust',
        highlight: 'nicht',
        suffix: 'ist',
      },
      notFeatures: [
        'Kein Social Media zum Scrollen',
        'Keine Werbung oder Tracking',
        'Keine Algorithmen die entscheiden was du siehst',
        'Keine Blockchain oder Crypto-Token',
      ],
      note: 'Dies ist ein Forschungsprojekt - wir lernen und verbessern kontinuierlich',
    },

    // Architecture
    architecture: {
      nav: 'Architektur',
      title: 'Wie es funktioniert',
      subtitle: 'Was dezentral ist, was (noch) Server braucht \u2014 und warum deine Daten trotzdem dir gehören.',
      backToHome: 'Zurück zur Startseite',

      // Three Pillars
      pillars: {
        title: 'Drei Säulen',
        items: [
          {
            title: 'Deine Identität gehört dir',
            description: 'Deine Identität wird auf deinem Gerät erzeugt \u2014 nicht auf einem Server. 12 Wörter, die nur du kennst, sind dein Schlüssel zu allem. Keine Registrierung, keine E-Mail, kein Anbieter.',
            technical: 'Dein Identifier (DID) enthält deinen öffentlichen Schlüssel. Jeder kann prüfen, ob eine Nachricht wirklich von dir kommt \u2014 ohne einen Server zu fragen.',
          },
          {
            title: 'Vertrauen durch echte Begegnung',
            description: 'Zwei Menschen treffen sich. Sie scannen gegenseitig einen QR-Code. Ab jetzt sind sie kryptografisch verifiziert \u2014 nicht weil ein Algorithmus es entschieden hat, sondern weil sie sich in die Augen geschaut haben.',
            technical: 'Attestations (Bestätigungen) werden Ende-zu-Ende verschlüsselt übertragen. Nicht einmal der Relay-Server kann mitlesen.',
          },
          {
            title: 'Deine Daten auf deinem Gerät',
            description: 'Alles wird lokal auf deinem Gerät gespeichert. Server helfen bei der Zustellung \u2014 aber sie sind nicht der Speicher.',
            technical: 'Wenn ein Server ausfällt, hast du immer noch all deine Daten, Kontakte und Verifikationen.',
          },
        ],
      },

      // Decentralized vs Server
      decentralized: {
        title: 'Was ist dezentral, was nutzt Server?',
        fullyDecentralized: {
          title: 'Vollständig dezentral',
          subtitle: 'Kein Server nötig',
          items: [
            { what: 'Identität', how: 'DID (did:key)', detail: 'Wird auf deinem Gerät erzeugt, aus 12 Wörtern ableitbar. Kein Server beteiligt.' },
            { what: 'Schlüssel', how: 'Ed25519 + X25519', detail: 'Signieren und Verschlüsseln \u2014 alles lokal, Private Key verlässt nie dein Gerät.' },
            { what: 'Verifikation', how: 'QR-Code / Challenge-Response', detail: 'Zwei Geräte kommunizieren direkt. Kein Server verifiziert \u2014 ihr verifiziert euch gegenseitig.' },
            { what: 'Datenspeicherung', how: 'Lokale Datenbank', detail: 'Kontakte, Verifikationen, Attestations \u2014 alles auf deinem Gerät.' },
            { what: 'Verschlüsselung', how: 'E2E (AES-256-GCM, ECIES)', detail: 'Nachrichten werden auf deinem Gerät verschlüsselt, bevor sie irgendwohin gehen.' },
          ],
        },
        serverAsHelper: {
          title: 'Server als Helfer',
          subtitle: 'Optional, austauschbar',
          items: [
            {
              what: 'Relay',
              description: 'Nachrichtenzustellung',
              why: 'Damit Nachrichten ankommen, wenn der Empfänger offline ist. Wie ein Briefkasten.',
              protection: 'Nachrichten sind E2E-verschlüsselt. Der Relay sieht nur: \u201EVon A an B\u201C \u2014 nicht den Inhalt.',
              roadmap: 'Ziel: P2P-Transport als dezentrale Alternative.',
            },
            {
              what: 'Profil-Service',
              description: 'Öffentliche Profile',
              why: 'Damit andere dein öffentliches Profil finden können, auch wenn du offline bist.',
              protection: 'Profile sind mit deinem Schlüssel signiert. Der Server kann sie nicht fälschen. Jeder Client verifiziert die Signatur.',
              roadmap: 'Ziel: Dezentrales Netzwerk als Alternative.',
            },
          ],
        },
        planned: {
          title: 'Geplant',
          subtitle: 'Noch nicht implementiert',
          items: [
            { what: 'Social Recovery', status: 'Geplant', goal: 'Gerät verloren? Deine Vertrauenspersonen bestätigen dein neues Profil \u2014 dein Web of Trust schützt dich.' },
            { what: 'Biometrie / Passkeys', status: 'Geplant', goal: 'Fingerabdruck statt Passphrase im Alltag. 12 Wörter als Fallback.' },
            { what: 'Key Rotation', status: 'Geplant', goal: 'Schlüssel wechseln, ohne Kontakte zu verlieren. Grundlage für Social Recovery.' },
            { what: 'Dezentrale Discovery', status: 'Geplant', goal: 'Profile in einem dezentralen Netzwerk statt auf einem Server.' },
            { what: 'P2P Messaging', status: 'Langfristig', goal: 'Direkte Zustellung ohne Relay, wenn beide online sind.' },
          ],
        },
      },

      // Server Protection
      serverProtection: {
        title: 'Auch mit Server: Deine Daten sind geschützt',
        question: '\u201EAber wenn es einen Server gibt, ist es doch nicht sicher?\u201C',
        answer: 'Doch. Und hier ist warum:',
        reasons: [
          {
            title: 'Der Server sieht nur verschlüsselte Daten.',
            description: 'Nachrichten werden auf deinem Gerät verschlüsselt, bevor sie an den Relay gehen. Der Server-Betreiber kann sie nicht lesen \u2014 selbst wenn er wollte.',
          },
          {
            title: 'Der Server kann deine Identität nicht fälschen.',
            description: 'Deine DID enthält deinen öffentlichen Schlüssel. Profile sind kryptografisch signiert. Ein kompromittierter Server kann keine Nachricht in deinem Namen schicken \u2014 die Signatur würde nicht passen.',
          },
          {
            title: 'Der Server ist austauschbar.',
            description: 'Du kannst jeden beliebigen Relay nutzen \u2014 oder deinen eigenen betreiben. Die Software ist Open Source. Es gibt keinen \u201Eden einen\u201C Server.',
          },
          {
            title: 'Der Server ist optional.',
            description: 'Wenn der Server ausfällt: Verifikation funktioniert weiter (QR-Code, direkt). Deine Daten sind lokal. Nur die Zustellung wartet, bis wieder ein Relay verfügbar ist.',
          },
        ],
        comparison: {
          title: 'Vergleich',
          items: [
            { name: 'Signal', detail: 'Server kennt deine Telefonnummer. Ohne Server = kein Signal.' },
            { name: 'WhatsApp', detail: 'Server kennt alles außer Nachrichteninhalt. Ohne Server = kein WhatsApp.' },
            { name: 'Web of Trust', detail: 'Server kennt verschlüsselte Briefumschläge. Ohne Server = alles funktioniert, nur langsamer.' },
          ],
        },
      },

      // Roadmap
      roadmap: {
        title: 'Der Weg zur vollständigen Dezentralisierung',
        phases: {
          today: 'Heute',
          tomorrow: 'Morgen',
          vision: 'Vision',
        },
        categories: [
          {
            name: 'Identität',
            today: { status: 'decentralized', label: 'Dezentral', detail: 'Auf deinem Gerät erzeugt' },
            tomorrow: { status: 'decentralized', label: 'Dezentral', detail: '+ Key Rotation' },
            vision: { status: 'decentralized', label: 'Dezentral', detail: 'Methoden-agnostisch' },
          },
          {
            name: 'Verifikation',
            today: { status: 'decentralized', label: 'Dezentral', detail: 'QR-Code, direkt' },
            tomorrow: { status: 'decentralized', label: 'Dezentral', detail: '' },
            vision: { status: 'decentralized', label: 'Dezentral', detail: '' },
          },
          {
            name: 'Datenspeicherung',
            today: { status: 'decentralized', label: 'Lokal', detail: 'Dein Gerät' },
            tomorrow: { status: 'decentralized', label: 'Lokal', detail: '' },
            vision: { status: 'decentralized', label: 'Lokal', detail: '' },
          },
          {
            name: 'Verschlüsselung',
            today: { status: 'decentralized', label: 'E2E', detail: 'AES-256, ECIES' },
            tomorrow: { status: 'decentralized', label: 'E2E', detail: '' },
            vision: { status: 'decentralized', label: 'E2E', detail: '' },
          },
          {
            name: 'Nachrichtenzustellung',
            today: { status: 'server', label: 'Relay-Server', detail: 'E2E-verschlüsselt' },
            tomorrow: { status: 'server', label: 'Relay + P2P', detail: '' },
            vision: { status: 'decentralized', label: 'Dezentral', detail: 'P2P / Federation' },
          },
          {
            name: 'Profil-Discovery',
            today: { status: 'server', label: 'HTTP-Server', detail: 'Kryptografisch signiert' },
            tomorrow: { status: 'server', label: 'Server + dezentral', detail: '' },
            vision: { status: 'decentralized', label: 'Dezentrales Netzwerk', detail: '' },
          },
          {
            name: 'Recovery',
            today: { status: 'manual', label: '12 Wörter', detail: 'Aufschreiben' },
            tomorrow: { status: 'wot', label: 'Social Recovery', detail: 'Dein Netzwerk bürgt' },
            vision: { status: 'wot', label: 'Web of Trust', detail: 'Schützt dich' },
          },
        ],
        legend: {
          decentralized: 'Vollständig dezentral',
          server: 'Server als Helfer, Daten geschützt',
          manual: 'Manuell',
          wot: 'Web of Trust basiert',
        },
      },

      // Tech Badges
      techBadges: [
        'Ed25519 Signaturen',
        'X25519 Verschlüsselung',
        'AES-256-GCM',
        'BIP39 Recovery',
        'Decentralized Identifiers',
        'HKDF Key Derivation',
        'JWS Signaturen',
        'Automerge CRDT',
        'Offline-First',
        'Open Source (MIT)',
      ],

      // FAQ
      faq: {
        title: 'Häufige Fragen zur Architektur',
        items: [
          {
            q: 'Ist das wirklich sicher?',
            a: 'Die Kryptografie basiert auf denselben Standards wie Signal und Bitcoin. Ed25519 für Signaturen, AES-256-GCM für Verschlüsselung. Der Code ist Open Source \u2014 jeder kann ihn prüfen.',
          },
          {
            q: 'Was wenn der Server gehackt wird?',
            a: 'Der Angreifer sieht verschlüsselte Nachrichten und signierte Profile. Er kann sie nicht lesen und nicht fälschen. Im schlimmsten Fall kann er die Zustellung stören \u2014 aber nicht deine Daten kompromittieren.',
          },
          {
            q: 'Was wenn ich mein Handy verliere?',
            a: 'Heute: Mit deinen 12 Wörtern kannst du deine Identität auf jedem Gerät wiederherstellen. Bald: Social Recovery \u2014 deine Vertrauenspersonen aus dem Web of Trust bestätigen dein neues Profil.',
          },
          {
            q: 'Warum nicht einfach Blockchain?',
            a: 'Blockchain löst ein anderes Problem (globaler Konsens). Wir brauchen keinen globalen Konsens \u2014 wir brauchen lokales Vertrauen zwischen Menschen, die sich kennen. Dezentral heißt nicht Blockchain.',
          },
        ],
      },
    },

    // FAQ
    faq: {
      title: 'Häufig gestellte Fragen',
      subtitle: 'Antworten auf die wichtigsten Fragen zum Web of Trust.',
      moreQuestions: 'Noch mehr Fragen?',
      askOnGithub: 'Auf GitHub stellen',
      categories: [
        {
          category: 'Grundlagen',
          questions: [
            {
              q: 'Was unterscheidet das von WhatsApp-Gruppen?',
              a: 'Deine Daten liegen bei dir, nicht bei Meta. Alles funktioniert offline. Attestationen bauen sichtbare Reputation auf. Kein Gruppen-Chaos mit 200 ungelesenen Nachrichten.',
            },
            {
              q: 'Warum muss ich jemanden persönlich treffen?',
              a: 'Das ist der Kern des Konzepts. Die persönliche Verifizierung ist der Sybil-Resistenz-Mechanismus. Ohne sie könnte jeder 1000 Fake-Accounts erstellen.',
            },
            {
              q: 'Was sehe ich wenn ich niemanden verifiziert habe?',
              a: 'Nichts außer deinem eigenen Profil. Das Netzwerk ist nur so groß wie deine echten Beziehungen.',
            },
            {
              q: 'Kann ich Leute einladen ohne sie zu treffen?',
              a: 'Nein. Das ist Absicht. Jede Beziehung im Netzwerk basiert auf einer echten Begegnung.',
            },
          ],
        },
        {
          category: 'Vertrauen & Attestationen',
          questions: [
            {
              q: 'Was ist der Unterschied zwischen Verifizierung und Attestation?',
              a: 'Verifizierung: "Ich habe diese Person getroffen, das ist wirklich sie." Attestation: "Diese Person hat X getan / kann Y." Verifizierung ist der Identitätsanker. Attestationen sind das eigentliche Vertrauen.',
            },
            {
              q: 'Kann ich eine Attestation zurücknehmen?',
              a: 'Nein. Attestationen sind signierte Aussagen über vergangene Ereignisse. Wenn sich die Beziehung ändert, erstellst du einfach keine neuen mehr.',
            },
            {
              q: 'Was wenn jemand Mist baut?',
              a: 'Du blendest die Person aus. Sie behält ihre alten Attestationen (sie hat die guten Taten ja wirklich getan), aber du siehst ihren Content nicht mehr. Andere können das auch tun.',
            },
          ],
        },
        {
          category: 'Technisches',
          questions: [
            {
              q: 'Was passiert wenn ich mein Handy verliere?',
              a: 'Wenn du deine Recovery-Phrase hast: Alles wiederherstellbar. Wenn nicht: Deine digitale Identität ist weg. Du musst neu anfangen und dich erneut verifizieren lassen.',
            },
            {
              q: 'Wo liegen meine Daten?',
              a: 'Lokal auf deinem Gerät. Verschlüsselt. Nur Leute die du verifiziert hast können sie entschlüsseln.',
            },
            {
              q: 'Gibt es einen Server?',
              a: 'Für die Synchronisation zwischen Geräten braucht es Infrastruktur. Diese speichert aber nur verschlüsselte Blobs - der Betreiber kann nichts lesen.',
            },
          ],
        },
        {
          category: 'Skalierung & Grenzen',
          questions: [
            {
              q: 'Was wenn das 10.000 Leute nutzen?',
              a: 'Das Netzwerk "skaliert" nicht im klassischen Sinne. Du siehst immer nur den Content von Leuten die du verifiziert hast. Bei 10.000 Nutzern gibt es viele kleine, überlappende Netzwerke.',
            },
            {
              q: 'Kann ich Leute sehen die "Freunde von Freunden" sind?',
              a: 'Im Basisfall: Nein. Du siehst nur Content von Leuten die du selbst verifiziert hast. Erweiterungen für Vertrauensketten sind denkbar, aber nicht im ersten Schritt.',
            },
          ],
        },
      ],
    },

    // Footer
    footer: {
      cta: {
        title: 'Bereit für echte Verbindungen?',
        subtitle: 'Wir suchen Gemeinschaften die es ausprobieren wollen, Feedback zu UX und Konzept, und Entwickler die mitbauen wollen.',
        github: 'Auf GitHub ansehen',
        spec: 'Spezifikation lesen',
      },
      projectTitle: 'Projekt',
      contributeTitle: 'Mitmachen',
      links: {
        project: {
          concept: 'Konzept',
          prototype: 'Prototyp',
          specification: 'Spezifikation',
        },
        contribute: {
          issues: 'GitHub Issues',
          feedback: 'Feedback geben',
          code: 'Code beitragen',
        },
      },
      description: 'Dezentrales Vertrauensnetzwerk für lokale Gemeinschaften. Ein Forschungsprojekt das echte Begegnungen über Algorithmen stellt.',
      license: 'Open Source unter MIT Lizenz',
      madeWith: {
        prefix: 'Gemacht mit',
        suffix: 'für lokale Gemeinschaften',
      },
    },
  },

  en: {
    // Header
    nav: {
      concept: 'Concept',
      howItWorks: 'How it works',
      apps: 'Apps',
      personas: 'For whom?',
      faq: 'FAQ',
      blog: 'Blog',
    },

    // Hero
    hero: {
      badge: 'Open Source Research Project',
      titleStart: 'Trust through',
      titleHighlight: 'real encounters',
      subtitle: 'A decentralized trust network for local communities with tools for self-organized collaboration where data is only shared encrypted with friends and groups.',
      cta: 'Learn more',
      demo: 'Try the Demo',
      github: 'View on GitHub',
      features: {
        verification: 'Personal verification',
        encrypted: 'End-to-end encrypted',
        offline: 'Works offline',
      },
    },

    // ProblemSolution
    problemSolution: {
      title: 'A different approach',
      subtitle: 'We focus on local communities instead of global platforms. Instead of algorithms, we build on real encounters.',
      today: 'Today',
      better: 'Better',
      problems: [
        { before: 'Social media captures attention', after: 'Connect in real life' },
        { before: 'Your data is with corporations', after: 'Your data stays with you' },
        { before: 'Trust through likes and stars', after: 'Trust through real encounters' },
        { before: 'Account creation alone at the screen', after: 'Onboarding through friends in a chain' },
        { before: 'Dependent on servers and connectivity', after: 'Works without internet' },
      ],
      pillarsTitle: 'The three pillars',
      pillars: [
        {
          title: 'Verify',
          description: 'Confirm identity through personal meeting',
          detail: 'Every relationship starts with a real encounter. By scanning a QR code you confirm: "This is really this person."',
        },
        {
          title: 'Cooperate',
          description: 'Share encrypted content',
          detail: 'Share calendars, locations and projects with your network. Everything end-to-end encrypted.',
        },
        {
          title: 'Attest',
          description: 'Build reputation through real actions',
          detail: 'Confirm what others have done. These attestations build visible trust over time.',
        },
      ],
      note: {
        title: 'Verify ≠ Trust',
        text: 'Verification only confirms: "This is really this person." Actual trust develops through attestations over time.',
      },
    },

    // HowItWorks
    howItWorks: {
      title: 'How it works',
      subtitle: 'From first meeting to first attestation - the path into the network.',
      step: 'Step',
      steps: [
        {
          title: 'Scan QR code',
          description: 'Anna and Ben meet. Ben scans Anna\'s QR code with the app.',
          detail: 'The QR code contains Anna\'s public key. Ben\'s app automatically creates his own identity.',
        },
        {
          title: 'Confirm identity',
          description: 'Ben confirms: "I have personally met Anna."',
          detail: 'This verification is cryptographically signed and keys are exchanged simultaneously.',
        },
        {
          title: 'See content',
          description: 'Ben can now see Anna\'s shared content.',
          detail: 'Calendar, map markers, projects - everything Anna shares with her contacts becomes decryptable for Ben.',
        },
        {
          title: 'Create attestation',
          description: 'After working together: Anna attests Ben\'s help.',
          detail: '"Ben helped 3 hours in the garden" - this signed statement becomes part of Ben\'s profile.',
        },
      ],
      result: {
        title: 'The result',
        text: 'A growing network of real relationships. Every connection is based on a personal encounter. Every attestation on a real action.',
      },
    },

    // Apps
    apps: {
      title: 'What you can do with it',
      subtitle: 'Web of Trust is the trust layer. Various apps build on it to enable local collaboration.',
      items: [
        {
          title: 'Map',
          description: 'Find people, places and offers nearby. See who can do what and where.',
        },
        {
          title: 'Calendar',
          description: 'Plan joint activities, coordinate dates and invite to events.',
        },
        {
          title: 'Marketplace',
          description: 'Share offers and requests. Exchange resources with people you trust.',
        },
        {
          title: 'Appreciation',
          description: 'Say thanks with digital vouchers. Gift time, help or a thank you.',
        },
      ],
      note: {
        prefix: 'All apps are built on',
        suffix: '– a modular open-source toolkit for local networking.',
      },
    },

    // Personas
    personas: {
      title: 'Who is Web of Trust for?',
      subtitle: 'People from local communities who want to build real connections.',
      needsLabel: 'Needs',
      howItHelpsLabel: 'How Web of Trust helps',
      items: [
        {
          name: 'Hanna (62)',
          role: 'The Gardener',
          background: 'Active in community garden, not tech-savvy, mainly uses WhatsApp.',
          needs: [
            'Know who waters when',
            'Find new helpers',
            'Not deal with technology',
          ],
          howItHelps: 'Her neighbor Tom sets up the app and verifies her. She sees the garden calendar and can tap "Thanks" - that becomes an attestation.',
        },
        {
          name: 'Alexander (34)',
          role: 'The Maker',
          background: 'Can fix anything, knows many people, organizes neighborhood help.',
          needs: [
            'Overview of who can do what',
            'Coordinate requests',
            'No WhatsApp group chaos',
          ],
          howItHelps: 'Actively verifies new people at meetings. Creates attestations: "Can fix bikes", "Can do electrical". Sees on the map who offers what.',
        },
        {
          name: 'Lena (28)',
          role: 'The Skeptic',
          background: 'Software developer, privacy-conscious, has seen many "decentralized" projects fail.',
          needs: [
            'Understand how it works technically',
            'Be sure data is encrypted',
            'No vendor lock-in',
          ],
          howItHelps: 'Open source - can check the code. E2E encryption with local keys. All data exportable.',
        },
        {
          name: 'The Kowalski Family',
          role: 'The Newcomers',
          background: 'New in town, don\'t know anyone, want to find connection.',
          needs: [
            'Meet neighbors',
            'Find trustworthy offers',
            'Become part of a community',
          ],
          howItHelps: 'First verifications at the street festival. Immediately see who has attestations. Can collect attestations themselves.',
        },
      ],
      note: 'The network only grows through real encounters - that takes time, but that\'s the point. No mass invitations, no fake accounts.',
    },

    // Principles
    principles: {
      title: 'The Principles',
      subtitle: 'What defines Web of Trust - and what it deliberately is not.',
      items: [
        {
          title: 'Data with you',
          description: 'All your data is encrypted on your device. Only people you\'ve verified can decrypt it.',
        },
        {
          title: 'Real encounters',
          description: 'Every relationship in the network is based on a personal meeting. This prevents fake accounts and spam.',
        },
        {
          title: 'Works offline',
          description: 'Create content, verify people, give attestations - everything works without internet. Sync happens later.',
        },
        {
          title: 'Open Source',
          description: 'The entire code is public. You can check how it works and even contribute.',
        },
        {
          title: 'You have the key',
          description: 'Your cryptographic identity belongs to you. With the recovery phrase you can restore it anytime.',
        },
        {
          title: 'Data exportable',
          description: 'No vendor lock-in. You can export all your data at any time.',
        },
      ],
      notTitle: {
        prefix: 'What Web of Trust is',
        highlight: 'not',
        suffix: '',
      },
      notFeatures: [
        'Not social media for scrolling',
        'No ads or tracking',
        'No algorithms deciding what you see',
        'No blockchain or crypto tokens',
      ],
      note: 'This is a research project - we learn and improve continuously',
    },

    // Architecture
    architecture: {
      nav: 'Architecture',
      title: 'How it works',
      subtitle: 'What\u2019s decentralized, what (still) needs servers \u2014 and why your data belongs to you regardless.',
      backToHome: 'Back to home',

      pillars: {
        title: 'Three Pillars',
        items: [
          {
            title: 'Your identity belongs to you',
            description: 'Your identity is created on your device \u2014 not on a server. 12 words that only you know are your key to everything. No registration, no email, no provider.',
            technical: 'Your identifier (DID) contains your public key. Anyone can verify whether a message really comes from you \u2014 without asking a server.',
          },
          {
            title: 'Trust through real encounter',
            description: 'Two people meet. They scan each other\u2019s QR code. From now on they are cryptographically verified \u2014 not because an algorithm decided, but because they looked each other in the eyes.',
            technical: 'Attestations (confirmations) are transmitted end-to-end encrypted. Not even the relay server can read along.',
          },
          {
            title: 'Your data on your device',
            description: 'Everything is stored locally on your device. Servers help with delivery \u2014 but they are not the storage.',
            technical: 'If a server goes down, you still have all your data, contacts, and verifications.',
          },
        ],
      },

      decentralized: {
        title: 'What\u2019s decentralized, what uses servers?',
        fullyDecentralized: {
          title: 'Fully decentralized',
          subtitle: 'No server needed',
          items: [
            { what: 'Identity', how: 'DID (did:key)', detail: 'Created on your device, derivable from 12 words. No server involved.' },
            { what: 'Keys', how: 'Ed25519 + X25519', detail: 'Signing and encrypting \u2014 all local, private key never leaves your device.' },
            { what: 'Verification', how: 'QR Code / Challenge-Response', detail: 'Two devices communicate directly. No server verifies \u2014 you verify each other.' },
            { what: 'Data storage', how: 'Local database', detail: 'Contacts, verifications, attestations \u2014 all on your device.' },
            { what: 'Encryption', how: 'E2E (AES-256-GCM, ECIES)', detail: 'Messages are encrypted on your device before they go anywhere.' },
          ],
        },
        serverAsHelper: {
          title: 'Server as helper',
          subtitle: 'Optional, replaceable',
          items: [
            {
              what: 'Relay',
              description: 'Message delivery',
              why: 'So messages arrive when the recipient is offline. Like a mailbox.',
              protection: 'Messages are E2E encrypted. The relay only sees: \u201CFrom A to B\u201D \u2014 not the content.',
              roadmap: 'Goal: P2P transport as decentralized alternative.',
            },
            {
              what: 'Profile Service',
              description: 'Public profiles',
              why: 'So others can find your public profile even when you\u2019re offline.',
              protection: 'Profiles are signed with your key. The server can\u2019t forge them. Every client verifies the signature.',
              roadmap: 'Goal: Decentralized network as alternative.',
            },
          ],
        },
        planned: {
          title: 'Planned',
          subtitle: 'Not yet implemented',
          items: [
            { what: 'Social Recovery', status: 'Planned', goal: 'Lost your device? Your trusted contacts confirm your new profile \u2014 your Web of Trust protects you.' },
            { what: 'Biometrics / Passkeys', status: 'Planned', goal: 'Fingerprint instead of passphrase in daily use. 12 words as fallback.' },
            { what: 'Key Rotation', status: 'Planned', goal: 'Change keys without losing contacts. Foundation for Social Recovery.' },
            { what: 'Decentralized Discovery', status: 'Planned', goal: 'Profiles in a decentralized network instead of on a server.' },
            { what: 'P2P Messaging', status: 'Long-term', goal: 'Direct delivery without relay when both are online.' },
          ],
        },
      },

      serverProtection: {
        title: 'Even with servers: Your data is protected',
        question: '\u201CBut if there\u2019s a server, it\u2019s not secure, right?\u201D',
        answer: 'It is. And here\u2019s why:',
        reasons: [
          {
            title: 'The server only sees encrypted data.',
            description: 'Messages are encrypted on your device before going to the relay. The server operator can\u2019t read them \u2014 even if they wanted to.',
          },
          {
            title: 'The server can\u2019t forge your identity.',
            description: 'Your DID contains your public key. Profiles are cryptographically signed. A compromised server can\u2019t send a message in your name \u2014 the signature wouldn\u2019t match.',
          },
          {
            title: 'The server is replaceable.',
            description: 'You can use any relay \u2014 or run your own. The software is open source. There is no \u201Cone\u201D server.',
          },
          {
            title: 'The server is optional.',
            description: 'If the server goes down: Verification still works (QR code, direct). Your data is local. Only delivery waits until a relay is available again.',
          },
        ],
        comparison: {
          title: 'Comparison',
          items: [
            { name: 'Signal', detail: 'Server knows your phone number. No server = no Signal.' },
            { name: 'WhatsApp', detail: 'Server knows everything except message content. No server = no WhatsApp.' },
            { name: 'Web of Trust', detail: 'Server knows encrypted envelopes. No server = everything works, just slower.' },
          ],
        },
      },

      roadmap: {
        title: 'The path to full decentralization',
        phases: {
          today: 'Today',
          tomorrow: 'Tomorrow',
          vision: 'Vision',
        },
        categories: [
          {
            name: 'Identity',
            today: { status: 'decentralized', label: 'Decentralized', detail: 'Created on your device' },
            tomorrow: { status: 'decentralized', label: 'Decentralized', detail: '+ Key Rotation' },
            vision: { status: 'decentralized', label: 'Decentralized', detail: 'Method-agnostic' },
          },
          {
            name: 'Verification',
            today: { status: 'decentralized', label: 'Decentralized', detail: 'QR code, direct' },
            tomorrow: { status: 'decentralized', label: 'Decentralized', detail: '' },
            vision: { status: 'decentralized', label: 'Decentralized', detail: '' },
          },
          {
            name: 'Data Storage',
            today: { status: 'decentralized', label: 'Local', detail: 'Your device' },
            tomorrow: { status: 'decentralized', label: 'Local', detail: '' },
            vision: { status: 'decentralized', label: 'Local', detail: '' },
          },
          {
            name: 'Encryption',
            today: { status: 'decentralized', label: 'E2E', detail: 'AES-256, ECIES' },
            tomorrow: { status: 'decentralized', label: 'E2E', detail: '' },
            vision: { status: 'decentralized', label: 'E2E', detail: '' },
          },
          {
            name: 'Message Delivery',
            today: { status: 'server', label: 'Relay Server', detail: 'E2E encrypted' },
            tomorrow: { status: 'server', label: 'Relay + P2P', detail: '' },
            vision: { status: 'decentralized', label: 'Decentralized', detail: 'P2P / Federation' },
          },
          {
            name: 'Profile Discovery',
            today: { status: 'server', label: 'HTTP Server', detail: 'Cryptographically signed' },
            tomorrow: { status: 'server', label: 'Server + decentralized', detail: '' },
            vision: { status: 'decentralized', label: 'Decentralized network', detail: '' },
          },
          {
            name: 'Recovery',
            today: { status: 'manual', label: '12 words', detail: 'Write down' },
            tomorrow: { status: 'wot', label: 'Social Recovery', detail: 'Your network vouches' },
            vision: { status: 'wot', label: 'Web of Trust', detail: 'Protects you' },
          },
        ],
        legend: {
          decentralized: 'Fully decentralized',
          server: 'Server as helper, data protected',
          manual: 'Manual',
          wot: 'Web of Trust based',
        },
      },

      techBadges: [
        'Ed25519 Signatures',
        'X25519 Encryption',
        'AES-256-GCM',
        'BIP39 Recovery',
        'Decentralized Identifiers',
        'HKDF Key Derivation',
        'JWS Signatures',
        'Automerge CRDT',
        'Offline-First',
        'Open Source (MIT)',
      ],

      faq: {
        title: 'Architecture FAQ',
        items: [
          {
            q: 'Is this really secure?',
            a: 'The cryptography is based on the same standards as Signal and Bitcoin. Ed25519 for signatures, AES-256-GCM for encryption. The code is open source \u2014 anyone can audit it.',
          },
          {
            q: 'What if the server gets hacked?',
            a: 'The attacker sees encrypted messages and signed profiles. They can\u2019t read or forge them. In the worst case, they can disrupt delivery \u2014 but not compromise your data.',
          },
          {
            q: 'What if I lose my phone?',
            a: 'Today: With your 12 words you can restore your identity on any device. Soon: Social Recovery \u2014 your trusted contacts from the Web of Trust confirm your new profile.',
          },
          {
            q: 'Why not just use blockchain?',
            a: 'Blockchain solves a different problem (global consensus). We don\u2019t need global consensus \u2014 we need local trust between people who know each other. Decentralized doesn\u2019t mean blockchain.',
          },
        ],
      },
    },

    // FAQ
    faq: {
      title: 'Frequently Asked Questions',
      subtitle: 'Answers to the most important questions about Web of Trust.',
      moreQuestions: 'More questions?',
      askOnGithub: 'Ask on GitHub',
      categories: [
        {
          category: 'Basics',
          questions: [
            {
              q: 'What makes this different from WhatsApp groups?',
              a: 'Your data stays with you, not with Meta. Everything works offline. Attestations build visible reputation. No group chaos with 200 unread messages.',
            },
            {
              q: 'Why do I have to meet someone in person?',
              a: 'That\'s the core of the concept. Personal verification is the Sybil resistance mechanism. Without it, anyone could create 1000 fake accounts.',
            },
            {
              q: 'What do I see if I haven\'t verified anyone?',
              a: 'Nothing except your own profile. The network is only as big as your real relationships.',
            },
            {
              q: 'Can I invite people without meeting them?',
              a: 'No. That\'s intentional. Every relationship in the network is based on a real encounter.',
            },
          ],
        },
        {
          category: 'Trust & Attestations',
          questions: [
            {
              q: 'What\'s the difference between verification and attestation?',
              a: 'Verification: "I met this person, it\'s really them." Attestation: "This person did X / can do Y." Verification is the identity anchor. Attestations are the actual trust.',
            },
            {
              q: 'Can I take back an attestation?',
              a: 'No. Attestations are signed statements about past events. If the relationship changes, you simply don\'t create new ones.',
            },
            {
              q: 'What if someone misbehaves?',
              a: 'You hide the person. They keep their old attestations (they did the good deeds), but you no longer see their content. Others can do the same.',
            },
          ],
        },
        {
          category: 'Technical',
          questions: [
            {
              q: 'What happens if I lose my phone?',
              a: 'If you have your recovery phrase: Everything is recoverable. If not: Your digital identity is gone. You have to start over and get verified again.',
            },
            {
              q: 'Where is my data stored?',
              a: 'Locally on your device. Encrypted. Only people you\'ve verified can decrypt it.',
            },
            {
              q: 'Is there a server?',
              a: 'Synchronization between devices needs infrastructure. But it only stores encrypted blobs - the operator can\'t read anything.',
            },
          ],
        },
        {
          category: 'Scaling & Limits',
          questions: [
            {
              q: 'What if 10,000 people use this?',
              a: 'The network doesn\'t "scale" in the traditional sense. You only see content from people you\'ve verified. With 10,000 users, there are many small, overlapping networks.',
            },
            {
              q: 'Can I see people who are "friends of friends"?',
              a: 'In the basic case: No. You only see content from people you\'ve verified yourself. Extensions for trust chains are conceivable, but not in the first step.',
            },
          ],
        },
      ],
    },

    // Footer
    footer: {
      cta: {
        title: 'Ready for real connections?',
        subtitle: 'We\'re looking for communities to try it out, feedback on UX and concept, and developers to build with us.',
        github: 'View on GitHub',
        spec: 'Read specification',
      },
      projectTitle: 'Project',
      contributeTitle: 'Contribute',
      links: {
        project: {
          concept: 'Concept',
          prototype: 'Prototype',
          specification: 'Specification',
        },
        contribute: {
          issues: 'GitHub Issues',
          feedback: 'Give feedback',
          code: 'Contribute code',
        },
      },
      description: 'Decentralized trust network for local communities. A research project that puts real encounters over algorithms.',
      license: 'Open source under MIT License',
      madeWith: {
        prefix: 'Made with',
        suffix: 'for local communities',
      },
    },
  },

  es: {
    // Header
    nav: {
      concept: 'Concepto',
      howItWorks: 'Cómo funciona',
      apps: 'Apps',
      personas: '¿Para quién?',
      faq: 'FAQ',
      blog: 'Blog',
    },

    // Hero
    hero: {
      badge: 'Proyecto de investigación Open Source',
      titleStart: 'Confianza a través de',
      titleHighlight: 'encuentros reales',
      subtitle: 'Una red de confianza descentralizada para comunidades locales con herramientas para la colaboración autoorganizada donde los datos solo se comparten cifrados con amigos y grupos.',
      cta: 'Saber más',
      demo: 'Probar la Demo',
      github: 'Ver en GitHub',
      features: {
        verification: 'Verificación personal',
        encrypted: 'Cifrado de extremo a extremo',
        offline: 'Funciona sin conexión',
      },
    },

    // ProblemSolution
    problemSolution: {
      title: 'Un enfoque diferente',
      subtitle: 'Nos enfocamos en comunidades locales en lugar de plataformas globales. En lugar de algoritmos, construimos sobre encuentros reales.',
      today: 'Hoy',
      better: 'Mejor',
      problems: [
        { before: 'Las redes sociales capturan la atención', after: 'Conectar en la vida real' },
        { before: 'Tus datos están con corporaciones', after: 'Tus datos se quedan contigo' },
        { before: 'Confianza a través de likes y estrellas', after: 'Confianza a través de encuentros reales' },
        { before: 'Creación de cuenta solo frente a la pantalla', after: 'Incorporación a través de amigos en cadena' },
        { before: 'Dependiente de servidores y conectividad', after: 'Funciona sin internet' },
      ],
      pillarsTitle: 'Los tres pilares',
      pillars: [
        {
          title: 'Verificar',
          description: 'Confirmar identidad mediante encuentro personal',
          detail: 'Cada relación comienza con un encuentro real. Al escanear un código QR confirmas: "Esta es realmente esta persona."',
        },
        {
          title: 'Cooperar',
          description: 'Compartir contenido cifrado',
          detail: 'Comparte calendarios, ubicaciones y proyectos con tu red. Todo cifrado de extremo a extremo.',
        },
        {
          title: 'Atestiguar',
          description: 'Construir reputación a través de acciones reales',
          detail: 'Confirma lo que otros han hecho. Estas atestaciones construyen confianza visible con el tiempo.',
        },
      ],
      note: {
        title: 'Verificar ≠ Confiar',
        text: 'La verificación solo confirma: "Esta es realmente esta persona." La confianza real se desarrolla a través de atestaciones con el tiempo.',
      },
    },

    // HowItWorks
    howItWorks: {
      title: 'Cómo funciona',
      subtitle: 'Desde el primer encuentro hasta la primera atestación - el camino hacia la red.',
      step: 'Paso',
      steps: [
        {
          title: 'Escanear código QR',
          description: 'Anna y Ben se encuentran. Ben escanea el código QR de Anna con la app.',
          detail: 'El código QR contiene la clave pública de Anna. La app de Ben crea automáticamente su propia identidad.',
        },
        {
          title: 'Confirmar identidad',
          description: 'Ben confirma: "He conocido personalmente a Anna."',
          detail: 'Esta verificación se firma criptográficamente y se intercambian claves simultáneamente.',
        },
        {
          title: 'Ver contenido',
          description: 'Ben ahora puede ver el contenido compartido de Anna.',
          detail: 'Calendario, marcadores de mapa, proyectos - todo lo que Anna comparte con sus contactos se vuelve descifrable para Ben.',
        },
        {
          title: 'Crear atestación',
          description: 'Después de trabajar juntos: Anna atestigua la ayuda de Ben.',
          detail: '"Ben ayudó 3 horas en el jardín" - esta declaración firmada se convierte en parte del perfil de Ben.',
        },
      ],
      result: {
        title: 'El resultado',
        text: 'Una red creciente de relaciones reales. Cada conexión se basa en un encuentro personal. Cada atestación en una acción real.',
      },
    },

    // Apps
    apps: {
      title: 'Qué puedes hacer con esto',
      subtitle: 'Web of Trust es la capa de confianza. Varias apps se construyen sobre ella para permitir la colaboración local.',
      items: [
        {
          title: 'Mapa',
          description: 'Encuentra personas, lugares y ofertas cercanas. Ve quién puede hacer qué y dónde.',
        },
        {
          title: 'Calendario',
          description: 'Planifica actividades conjuntas, coordina fechas e invita a eventos.',
        },
        {
          title: 'Mercado',
          description: 'Comparte ofertas y solicitudes. Intercambia recursos con personas en las que confías.',
        },
        {
          title: 'Agradecimiento',
          description: 'Da las gracias con vales digitales. Regala tiempo, ayuda o un agradecimiento.',
        },
      ],
      note: {
        prefix: 'Todas las apps están construidas sobre',
        suffix: '– un kit de herramientas modular de código abierto para redes locales.',
      },
    },

    // Personas
    personas: {
      title: '¿Para quién es Web of Trust?',
      subtitle: 'Personas de comunidades locales que quieren construir conexiones reales.',
      needsLabel: 'Necesidades',
      howItHelpsLabel: 'Cómo ayuda Web of Trust',
      items: [
        {
          name: 'Hanna (62)',
          role: 'La Jardinera',
          background: 'Activa en el jardín comunitario, no es experta en tecnología, usa principalmente WhatsApp.',
          needs: [
            'Saber quién riega cuándo',
            'Encontrar nuevos ayudantes',
            'No lidiar con tecnología',
          ],
          howItHelps: 'Su vecino Tom configura la app y la verifica. Ella ve el calendario del jardín y puede tocar "Gracias" - eso se convierte en una atestación.',
        },
        {
          name: 'Alexander (34)',
          role: 'El Hacedor',
          background: 'Puede arreglar cualquier cosa, conoce a mucha gente, organiza ayuda vecinal.',
          needs: [
            'Vista general de quién puede hacer qué',
            'Coordinar solicitudes',
            'Sin caos de grupos de WhatsApp',
          ],
          howItHelps: 'Verifica activamente a nuevas personas en reuniones. Crea atestaciones: "Puede arreglar bicis", "Puede hacer electricidad". Ve en el mapa quién ofrece qué.',
        },
        {
          name: 'Lena (28)',
          role: 'La Escéptica',
          background: 'Desarrolladora de software, consciente de la privacidad, ha visto fracasar muchos proyectos "descentralizados".',
          needs: [
            'Entender cómo funciona técnicamente',
            'Estar segura de que los datos están cifrados',
            'Sin dependencia de proveedor',
          ],
          howItHelps: 'Código abierto - puede revisar el código. Cifrado E2E con claves locales. Todos los datos exportables.',
        },
        {
          name: 'Familia Kowalski',
          role: 'Los Recién Llegados',
          background: 'Nuevos en la ciudad, no conocen a nadie, quieren encontrar conexión.',
          needs: [
            'Conocer vecinos',
            'Encontrar ofertas confiables',
            'Ser parte de una comunidad',
          ],
          howItHelps: 'Primeras verificaciones en la fiesta del barrio. Ven inmediatamente quién tiene atestaciones. Pueden recopilar atestaciones ellos mismos.',
        },
      ],
      note: 'La red solo crece a través de encuentros reales - eso lleva tiempo, pero ese es el punto. Sin invitaciones masivas, sin cuentas falsas.',
    },

    // Principles
    principles: {
      title: 'Los Principios',
      subtitle: 'Lo que define a Web of Trust - y lo que deliberadamente no es.',
      items: [
        {
          title: 'Datos contigo',
          description: 'Todos tus datos están cifrados en tu dispositivo. Solo las personas que has verificado pueden descifrarlos.',
        },
        {
          title: 'Encuentros reales',
          description: 'Cada relación en la red se basa en un encuentro personal. Esto previene cuentas falsas y spam.',
        },
        {
          title: 'Funciona sin conexión',
          description: 'Crear contenido, verificar personas, dar atestaciones - todo funciona sin internet. La sincronización ocurre después.',
        },
        {
          title: 'Código Abierto',
          description: 'Todo el código es público. Puedes verificar cómo funciona e incluso contribuir.',
        },
        {
          title: 'Tú tienes la clave',
          description: 'Tu identidad criptográfica te pertenece. Con la frase de recuperación puedes restaurarla en cualquier momento.',
        },
        {
          title: 'Datos exportables',
          description: 'Sin dependencia de proveedor. Puedes exportar todos tus datos en cualquier momento.',
        },
      ],
      notTitle: {
        prefix: 'Lo que Web of Trust',
        highlight: 'no',
        suffix: 'es',
      },
      notFeatures: [
        'No es una red social para desplazarse',
        'Sin anuncios ni seguimiento',
        'Sin algoritmos que decidan lo que ves',
        'Sin blockchain ni tokens crypto',
      ],
      note: 'Este es un proyecto de investigación - aprendemos y mejoramos continuamente',
    },

    // FAQ
    faq: {
      title: 'Preguntas Frecuentes',
      subtitle: 'Respuestas a las preguntas más importantes sobre Web of Trust.',
      moreQuestions: '¿Más preguntas?',
      askOnGithub: 'Preguntar en GitHub',
      categories: [
        {
          category: 'Conceptos básicos',
          questions: [
            {
              q: '¿Qué hace esto diferente de los grupos de WhatsApp?',
              a: 'Tus datos se quedan contigo, no con Meta. Todo funciona sin conexión. Las atestaciones construyen reputación visible. Sin caos de grupo con 200 mensajes sin leer.',
            },
            {
              q: '¿Por qué tengo que conocer a alguien en persona?',
              a: 'Ese es el núcleo del concepto. La verificación personal es el mecanismo de resistencia Sybil. Sin ella, cualquiera podría crear 1000 cuentas falsas.',
            },
            {
              q: '¿Qué veo si no he verificado a nadie?',
              a: 'Nada excepto tu propio perfil. La red es solo tan grande como tus relaciones reales.',
            },
            {
              q: '¿Puedo invitar personas sin conocerlas?',
              a: 'No. Es intencional. Cada relación en la red se basa en un encuentro real.',
            },
          ],
        },
        {
          category: 'Confianza y Atestaciones',
          questions: [
            {
              q: '¿Cuál es la diferencia entre verificación y atestación?',
              a: 'Verificación: "Conocí a esta persona, realmente es ella." Atestación: "Esta persona hizo X / puede hacer Y." La verificación es el ancla de identidad. Las atestaciones son la confianza real.',
            },
            {
              q: '¿Puedo retirar una atestación?',
              a: 'No. Las atestaciones son declaraciones firmadas sobre eventos pasados. Si la relación cambia, simplemente no creas nuevas.',
            },
            {
              q: '¿Qué pasa si alguien se porta mal?',
              a: 'Ocultas a la persona. Mantiene sus antiguas atestaciones (hizo las buenas acciones), pero ya no ves su contenido. Otros pueden hacer lo mismo.',
            },
          ],
        },
        {
          category: 'Técnico',
          questions: [
            {
              q: '¿Qué pasa si pierdo mi teléfono?',
              a: 'Si tienes tu frase de recuperación: Todo es recuperable. Si no: Tu identidad digital se perdió. Tienes que empezar de nuevo y ser verificado otra vez.',
            },
            {
              q: '¿Dónde se almacenan mis datos?',
              a: 'Localmente en tu dispositivo. Cifrados. Solo las personas que has verificado pueden descifrarlos.',
            },
            {
              q: '¿Hay un servidor?',
              a: 'La sincronización entre dispositivos necesita infraestructura. Pero solo almacena blobs cifrados - el operador no puede leer nada.',
            },
          ],
        },
        {
          category: 'Escalabilidad y Límites',
          questions: [
            {
              q: '¿Qué pasa si 10,000 personas usan esto?',
              a: 'La red no "escala" en el sentido tradicional. Solo ves contenido de personas que has verificado. Con 10,000 usuarios, hay muchas redes pequeñas y superpuestas.',
            },
            {
              q: '¿Puedo ver personas que son "amigos de amigos"?',
              a: 'En el caso básico: No. Solo ves contenido de personas que has verificado tú mismo. Extensiones para cadenas de confianza son concebibles, pero no en el primer paso.',
            },
          ],
        },
      ],
    },

    // Footer
    footer: {
      cta: {
        title: '¿Listo para conexiones reales?',
        subtitle: 'Buscamos comunidades para probarlo, feedback sobre UX y concepto, y desarrolladores para construir con nosotros.',
        github: 'Ver en GitHub',
        spec: 'Leer especificación',
      },
      projectTitle: 'Proyecto',
      contributeTitle: 'Contribuir',
      links: {
        project: {
          concept: 'Concepto',
          prototype: 'Prototipo',
          specification: 'Especificación',
        },
        contribute: {
          issues: 'GitHub Issues',
          feedback: 'Dar feedback',
          code: 'Contribuir código',
        },
      },
      description: 'Red de confianza descentralizada para comunidades locales. Un proyecto de investigación que pone los encuentros reales sobre los algoritmos.',
      license: 'Código abierto bajo licencia MIT',
      madeWith: {
        prefix: 'Hecho con',
        suffix: 'para comunidades locales',
      },
    },
  },

  pt: {
    // Header
    nav: {
      concept: 'Conceito',
      howItWorks: 'Como funciona',
      apps: 'Apps',
      personas: 'Para quem?',
      faq: 'FAQ',
      blog: 'Blog',
    },

    // Hero
    hero: {
      badge: 'Projeto de pesquisa Open Source',
      titleStart: 'Confiança através de',
      titleHighlight: 'encontros reais',
      subtitle: 'Uma rede de confiança descentralizada para comunidades locais com ferramentas para colaboração auto-organizada onde dados são compartilhados apenas criptografados com amigos e grupos.',
      cta: 'Saiba mais',
      demo: 'Experimentar a Demo',
      github: 'Ver no GitHub',
      features: {
        verification: 'Verificação pessoal',
        encrypted: 'Criptografia ponta a ponta',
        offline: 'Funciona offline',
      },
    },

    // ProblemSolution
    problemSolution: {
      title: 'Uma abordagem diferente',
      subtitle: 'Focamos em comunidades locais em vez de plataformas globais. Em vez de algoritmos, construímos sobre encontros reais.',
      today: 'Hoje',
      better: 'Melhor',
      problems: [
        { before: 'Redes sociais capturam atenção', after: 'Conectar na vida real' },
        { before: 'Seus dados estão com corporações', after: 'Seus dados ficam com você' },
        { before: 'Confiança através de likes e estrelas', after: 'Confiança através de encontros reais' },
        { before: 'Criação de conta sozinho na tela', after: 'Integração através de amigos em cadeia' },
        { before: 'Dependente de servidores e conectividade', after: 'Funciona sem internet' },
      ],
      pillarsTitle: 'Os três pilares',
      pillars: [
        {
          title: 'Verificar',
          description: 'Confirmar identidade através de encontro pessoal',
          detail: 'Cada relação começa com um encontro real. Ao escanear um código QR você confirma: "Esta é realmente esta pessoa."',
        },
        {
          title: 'Cooperar',
          description: 'Compartilhar conteúdo criptografado',
          detail: 'Compartilhe calendários, localizações e projetos com sua rede. Tudo criptografado ponta a ponta.',
        },
        {
          title: 'Atestar',
          description: 'Construir reputação através de ações reais',
          detail: 'Confirme o que outros fizeram. Essas atestações constroem confiança visível ao longo do tempo.',
        },
      ],
      note: {
        title: 'Verificar ≠ Confiar',
        text: 'A verificação apenas confirma: "Esta é realmente esta pessoa." A confiança real se desenvolve através de atestações ao longo do tempo.',
      },
    },

    // HowItWorks
    howItWorks: {
      title: 'Como funciona',
      subtitle: 'Do primeiro encontro à primeira atestação - o caminho para a rede.',
      step: 'Passo',
      steps: [
        {
          title: 'Escanear código QR',
          description: 'Anna e Ben se encontram. Ben escaneia o código QR de Anna com o app.',
          detail: 'O código QR contém a chave pública de Anna. O app de Ben cria automaticamente sua própria identidade.',
        },
        {
          title: 'Confirmar identidade',
          description: 'Ben confirma: "Conheci Anna pessoalmente."',
          detail: 'Esta verificação é assinada criptograficamente e as chaves são trocadas simultaneamente.',
        },
        {
          title: 'Ver conteúdo',
          description: 'Ben agora pode ver o conteúdo compartilhado de Anna.',
          detail: 'Calendário, marcadores de mapa, projetos - tudo que Anna compartilha com seus contatos se torna descriptografável para Ben.',
        },
        {
          title: 'Criar atestação',
          description: 'Depois de trabalhar juntos: Anna atesta a ajuda de Ben.',
          detail: '"Ben ajudou 3 horas no jardim" - esta declaração assinada se torna parte do perfil de Ben.',
        },
      ],
      result: {
        title: 'O resultado',
        text: 'Uma rede crescente de relacionamentos reais. Cada conexão é baseada em um encontro pessoal. Cada atestação em uma ação real.',
      },
    },

    // Apps
    apps: {
      title: 'O que você pode fazer com isso',
      subtitle: 'Web of Trust é a camada de confiança. Vários apps são construídos sobre ela para permitir colaboração local.',
      items: [
        {
          title: 'Mapa',
          description: 'Encontre pessoas, lugares e ofertas próximas. Veja quem pode fazer o quê e onde.',
        },
        {
          title: 'Calendário',
          description: 'Planeje atividades conjuntas, coordene datas e convide para eventos.',
        },
        {
          title: 'Mercado',
          description: 'Compartilhe ofertas e pedidos. Troque recursos com pessoas em quem você confia.',
        },
        {
          title: 'Agradecimento',
          description: 'Agradeça com vales digitais. Presenteie tempo, ajuda ou um agradecimento.',
        },
      ],
      note: {
        prefix: 'Todos os apps são construídos sobre',
        suffix: '– um kit de ferramentas modular de código aberto para redes locais.',
      },
    },

    // Personas
    personas: {
      title: 'Para quem é o Web of Trust?',
      subtitle: 'Pessoas de comunidades locais que querem construir conexões reais.',
      needsLabel: 'Necessidades',
      howItHelpsLabel: 'Como o Web of Trust ajuda',
      items: [
        {
          name: 'Hanna (62)',
          role: 'A Jardineira',
          background: 'Ativa na horta comunitária, não é expert em tecnologia, usa principalmente WhatsApp.',
          needs: [
            'Saber quem rega quando',
            'Encontrar novos ajudantes',
            'Não lidar com tecnologia',
          ],
          howItHelps: 'Seu vizinho Tom configura o app e a verifica. Ela vê o calendário da horta e pode tocar "Obrigada" - isso se torna uma atestação.',
        },
        {
          name: 'Alexander (34)',
          role: 'O Fazedor',
          background: 'Pode consertar qualquer coisa, conhece muitas pessoas, organiza ajuda de vizinhança.',
          needs: [
            'Visão geral de quem pode fazer o quê',
            'Coordenar pedidos',
            'Sem caos de grupos de WhatsApp',
          ],
          howItHelps: 'Verifica ativamente novas pessoas em encontros. Cria atestações: "Pode consertar bicicletas", "Pode fazer elétrica". Vê no mapa quem oferece o quê.',
        },
        {
          name: 'Lena (28)',
          role: 'A Cética',
          background: 'Desenvolvedora de software, consciente sobre privacidade, já viu muitos projetos "descentralizados" fracassarem.',
          needs: [
            'Entender como funciona tecnicamente',
            'Ter certeza de que os dados são criptografados',
            'Sem dependência de fornecedor',
          ],
          howItHelps: 'Código aberto - pode verificar o código. Criptografia E2E com chaves locais. Todos os dados exportáveis.',
        },
        {
          name: 'Família Kowalski',
          role: 'Os Recém-Chegados',
          background: 'Novos na cidade, não conhecem ninguém, querem encontrar conexão.',
          needs: [
            'Conhecer vizinhos',
            'Encontrar ofertas confiáveis',
            'Fazer parte de uma comunidade',
          ],
          howItHelps: 'Primeiras verificações na festa de rua. Veem imediatamente quem tem atestações. Podem coletar atestações eles mesmos.',
        },
      ],
      note: 'A rede só cresce através de encontros reais - isso leva tempo, mas esse é o ponto. Sem convites em massa, sem contas falsas.',
    },

    // Principles
    principles: {
      title: 'Os Princípios',
      subtitle: 'O que define o Web of Trust - e o que deliberadamente não é.',
      items: [
        {
          title: 'Dados com você',
          description: 'Todos os seus dados são criptografados no seu dispositivo. Apenas pessoas que você verificou podem descriptografá-los.',
        },
        {
          title: 'Encontros reais',
          description: 'Cada relacionamento na rede é baseado em um encontro pessoal. Isso previne contas falsas e spam.',
        },
        {
          title: 'Funciona offline',
          description: 'Criar conteúdo, verificar pessoas, dar atestações - tudo funciona sem internet. A sincronização acontece depois.',
        },
        {
          title: 'Código Aberto',
          description: 'Todo o código é público. Você pode verificar como funciona e até contribuir.',
        },
        {
          title: 'Você tem a chave',
          description: 'Sua identidade criptográfica pertence a você. Com a frase de recuperação você pode restaurá-la a qualquer momento.',
        },
        {
          title: 'Dados exportáveis',
          description: 'Sem dependência de fornecedor. Você pode exportar todos os seus dados a qualquer momento.',
        },
      ],
      notTitle: {
        prefix: 'O que Web of Trust',
        highlight: 'não',
        suffix: 'é',
      },
      notFeatures: [
        'Não é rede social para rolar',
        'Sem anúncios ou rastreamento',
        'Sem algoritmos decidindo o que você vê',
        'Sem blockchain ou tokens cripto',
      ],
      note: 'Este é um projeto de pesquisa - aprendemos e melhoramos continuamente',
    },

    // FAQ
    faq: {
      title: 'Perguntas Frequentes',
      subtitle: 'Respostas para as perguntas mais importantes sobre o Web of Trust.',
      moreQuestions: 'Mais perguntas?',
      askOnGithub: 'Perguntar no GitHub',
      categories: [
        {
          category: 'Básicos',
          questions: [
            {
              q: 'O que torna isso diferente dos grupos de WhatsApp?',
              a: 'Seus dados ficam com você, não com a Meta. Tudo funciona offline. Atestações constroem reputação visível. Sem caos de grupo com 200 mensagens não lidas.',
            },
            {
              q: 'Por que tenho que conhecer alguém pessoalmente?',
              a: 'Esse é o núcleo do conceito. A verificação pessoal é o mecanismo de resistência Sybil. Sem ela, qualquer um poderia criar 1000 contas falsas.',
            },
            {
              q: 'O que vejo se não verifiquei ninguém?',
              a: 'Nada exceto seu próprio perfil. A rede é apenas tão grande quanto seus relacionamentos reais.',
            },
            {
              q: 'Posso convidar pessoas sem conhecê-las?',
              a: 'Não. É intencional. Cada relacionamento na rede é baseado em um encontro real.',
            },
          ],
        },
        {
          category: 'Confiança e Atestações',
          questions: [
            {
              q: 'Qual é a diferença entre verificação e atestação?',
              a: 'Verificação: "Conheci esta pessoa, é realmente ela." Atestação: "Esta pessoa fez X / pode fazer Y." A verificação é a âncora de identidade. As atestações são a confiança real.',
            },
            {
              q: 'Posso retirar uma atestação?',
              a: 'Não. Atestações são declarações assinadas sobre eventos passados. Se o relacionamento mudar, você simplesmente não cria novas.',
            },
            {
              q: 'E se alguém se comportar mal?',
              a: 'Você oculta a pessoa. Ela mantém suas atestações antigas (ela fez as boas ações), mas você não vê mais o conteúdo dela. Outros podem fazer o mesmo.',
            },
          ],
        },
        {
          category: 'Técnico',
          questions: [
            {
              q: 'O que acontece se eu perder meu telefone?',
              a: 'Se você tem sua frase de recuperação: Tudo é recuperável. Se não: Sua identidade digital foi perdida. Você tem que começar de novo e ser verificado novamente.',
            },
            {
              q: 'Onde meus dados são armazenados?',
              a: 'Localmente no seu dispositivo. Criptografados. Apenas pessoas que você verificou podem descriptografá-los.',
            },
            {
              q: 'Existe um servidor?',
              a: 'A sincronização entre dispositivos precisa de infraestrutura. Mas ela só armazena blobs criptografados - o operador não pode ler nada.',
            },
          ],
        },
        {
          category: 'Escalabilidade e Limites',
          questions: [
            {
              q: 'E se 10.000 pessoas usarem isso?',
              a: 'A rede não "escala" no sentido tradicional. Você só vê conteúdo de pessoas que verificou. Com 10.000 usuários, há muitas redes pequenas e sobrepostas.',
            },
            {
              q: 'Posso ver pessoas que são "amigos de amigos"?',
              a: 'No caso básico: Não. Você só vê conteúdo de pessoas que você mesmo verificou. Extensões para cadeias de confiança são concebíveis, mas não no primeiro passo.',
            },
          ],
        },
      ],
    },

    // Footer
    footer: {
      cta: {
        title: 'Pronto para conexões reais?',
        subtitle: 'Procuramos comunidades para experimentar, feedback sobre UX e conceito, e desenvolvedores para construir conosco.',
        github: 'Ver no GitHub',
        spec: 'Ler especificação',
      },
      projectTitle: 'Projeto',
      contributeTitle: 'Contribuir',
      links: {
        project: {
          concept: 'Conceito',
          prototype: 'Protótipo',
          specification: 'Especificação',
        },
        contribute: {
          issues: 'GitHub Issues',
          feedback: 'Dar feedback',
          code: 'Contribuir código',
        },
      },
      description: 'Rede de confiança descentralizada para comunidades locais. Um projeto de pesquisa que coloca encontros reais acima de algoritmos.',
      license: 'Código aberto sob licença MIT',
      madeWith: {
        prefix: 'Feito com',
        suffix: 'para comunidades locais',
      },
    },
  },

  ar: {
    // Header
    nav: {
      concept: 'المفهوم',
      howItWorks: 'كيف يعمل',
      apps: 'التطبيقات',
      personas: 'لمن؟',
      faq: 'الأسئلة الشائعة',
    },

    // Hero
    hero: {
      badge: 'مشروع بحثي مفتوح المصدر',
      titleStart: 'الثقة من خلال',
      titleHighlight: 'اللقاءات الحقيقية',
      subtitle: 'شبكة ثقة لامركزية للمجتمعات المحلية مع أدوات للتعاون الذاتي حيث تتم مشاركة البيانات مشفرة فقط مع الأصدقاء والمجموعات.',
      cta: 'اعرف المزيد',
      demo: 'جرّب العرض التجريبي',
      github: 'عرض على GitHub',
      features: {
        verification: 'التحقق الشخصي',
        encrypted: 'تشفير من طرف إلى طرف',
        offline: 'يعمل بدون اتصال',
      },
    },

    // ProblemSolution
    problemSolution: {
      title: 'نهج مختلف',
      subtitle: 'نركز على المجتمعات المحلية بدلاً من المنصات العالمية. بدلاً من الخوارزميات، نبني على اللقاءات الحقيقية.',
      today: 'اليوم',
      better: 'أفضل',
      problems: [
        { before: 'وسائل التواصل الاجتماعي تستحوذ على الانتباه', after: 'التواصل في الحياة الحقيقية' },
        { before: 'بياناتك لدى الشركات', after: 'بياناتك تبقى معك' },
        { before: 'الثقة من خلال الإعجابات والنجوم', after: 'الثقة من خلال اللقاءات الحقيقية' },
        { before: 'إنشاء حساب بمفردك أمام الشاشة', after: 'الانضمام من خلال الأصدقاء في سلسلة' },
        { before: 'الاعتماد على الخوادم والاتصال', after: 'يعمل بدون إنترنت' },
      ],
      pillarsTitle: 'الركائز الثلاث',
      pillars: [
        {
          title: 'التحقق',
          description: 'تأكيد الهوية من خلال اللقاء الشخصي',
          detail: 'كل علاقة تبدأ بلقاء حقيقي. بمسح رمز QR تؤكد: "هذا هو فعلاً هذا الشخص."',
        },
        {
          title: 'التعاون',
          description: 'مشاركة محتوى مشفر',
          detail: 'شارك التقويمات والمواقع والمشاريع مع شبكتك. كل شيء مشفر من طرف إلى طرف.',
        },
        {
          title: 'الشهادة',
          description: 'بناء السمعة من خلال أفعال حقيقية',
          detail: 'أكد ما فعله الآخرون. هذه الشهادات تبني ثقة مرئية مع مرور الوقت.',
        },
      ],
      note: {
        title: 'التحقق ≠ الثقة',
        text: 'التحقق يؤكد فقط: "هذا هو فعلاً هذا الشخص." الثقة الفعلية تتطور من خلال الشهادات مع مرور الوقت.',
      },
    },

    // HowItWorks
    howItWorks: {
      title: 'كيف يعمل',
      subtitle: 'من اللقاء الأول إلى الشهادة الأولى - الطريق إلى الشبكة.',
      step: 'الخطوة',
      steps: [
        {
          title: 'مسح رمز QR',
          description: 'آنا وبن يلتقيان. بن يمسح رمز QR الخاص بآنا بالتطبيق.',
          detail: 'رمز QR يحتوي على المفتاح العام لآنا. تطبيق بن ينشئ تلقائياً هويته الخاصة.',
        },
        {
          title: 'تأكيد الهوية',
          description: 'بن يؤكد: "لقد قابلت آنا شخصياً."',
          detail: 'هذا التحقق يتم توقيعه تشفيرياً ويتم تبادل المفاتيح في نفس الوقت.',
        },
        {
          title: 'رؤية المحتوى',
          description: 'بن يمكنه الآن رؤية محتوى آنا المشارك.',
          detail: 'التقويم، علامات الخريطة، المشاريع - كل ما تشاركه آنا مع جهات اتصالها يصبح قابلاً للفك لبن.',
        },
        {
          title: 'إنشاء شهادة',
          description: 'بعد العمل معاً: آنا تشهد على مساعدة بن.',
          detail: '"بن ساعد 3 ساعات في الحديقة" - هذا البيان الموقع يصبح جزءاً من ملف بن.',
        },
      ],
      result: {
        title: 'النتيجة',
        text: 'شبكة متنامية من العلاقات الحقيقية. كل اتصال يستند إلى لقاء شخصي. كل شهادة إلى عمل حقيقي.',
      },
    },

    // Apps
    apps: {
      title: 'ما يمكنك فعله بهذا',
      subtitle: 'شبكة الثقة هي طبقة الثقة. تطبيقات مختلفة تُبنى عليها لتمكين التعاون المحلي.',
      items: [
        {
          title: 'الخريطة',
          description: 'اعثر على الأشخاص والأماكن والعروض القريبة. انظر من يستطيع فعل ماذا وأين.',
        },
        {
          title: 'التقويم',
          description: 'خطط لأنشطة مشتركة، نسق المواعيد وادعُ للفعاليات.',
        },
        {
          title: 'السوق',
          description: 'شارك العروض والطلبات. تبادل الموارد مع أشخاص تثق بهم.',
        },
        {
          title: 'التقدير',
          description: 'قل شكراً بقسائم رقمية. أهدِ الوقت أو المساعدة أو كلمة شكر.',
        },
      ],
      note: {
        prefix: 'جميع التطبيقات مبنية على',
        suffix: '– مجموعة أدوات معيارية مفتوحة المصدر للشبكات المحلية.',
      },
    },

    // Personas
    personas: {
      title: 'لمن شبكة الثقة؟',
      subtitle: 'أشخاص من المجتمعات المحلية يريدون بناء علاقات حقيقية.',
      needsLabel: 'الاحتياجات',
      howItHelpsLabel: 'كيف تساعد شبكة الثقة',
      items: [
        {
          name: 'هنا (62)',
          role: 'البستانية',
          background: 'نشطة في حديقة المجتمع، ليست خبيرة بالتقنية، تستخدم واتساب بشكل رئيسي.',
          needs: [
            'معرفة من يسقي متى',
            'إيجاد مساعدين جدد',
            'عدم التعامل مع التقنية',
          ],
          howItHelps: 'جارها توم يُعد التطبيق ويتحقق منها. ترى تقويم الحديقة ويمكنها الضغط على "شكراً" - وهذا يصبح شهادة.',
        },
        {
          name: 'ألكسندر (34)',
          role: 'الصانع',
          background: 'يستطيع إصلاح أي شيء، يعرف كثيراً من الناس، ينظم مساعدة الجيران.',
          needs: [
            'نظرة عامة على من يستطيع فعل ماذا',
            'تنسيق الطلبات',
            'بدون فوضى مجموعات واتساب',
          ],
          howItHelps: 'يتحقق بنشاط من أشخاص جدد في اللقاءات. ينشئ شهادات: "يستطيع إصلاح الدراجات"، "يستطيع عمل الكهرباء". يرى على الخريطة من يقدم ماذا.',
        },
        {
          name: 'لينا (28)',
          role: 'المتشككة',
          background: 'مطورة برمجيات، واعية بالخصوصية، رأت العديد من المشاريع "اللامركزية" تفشل.',
          needs: [
            'فهم كيف يعمل تقنياً',
            'التأكد من أن البيانات مشفرة',
            'بدون قفل المورد',
          ],
          howItHelps: 'مفتوح المصدر - يمكنها فحص الكود. تشفير E2E بمفاتيح محلية. جميع البيانات قابلة للتصدير.',
        },
        {
          name: 'عائلة كوالسكي',
          role: 'القادمون الجدد',
          background: 'جدد في المدينة، لا يعرفون أحداً، يريدون إيجاد ارتباط.',
          needs: [
            'التعرف على الجيران',
            'إيجاد عروض موثوقة',
            'أن يصبحوا جزءاً من مجتمع',
          ],
          howItHelps: 'أول التحققات في مهرجان الشارع. يرون فوراً من لديه شهادات. يمكنهم جمع شهادات بأنفسهم.',
        },
      ],
      note: 'الشبكة تنمو فقط من خلال اللقاءات الحقيقية - هذا يستغرق وقتاً، لكن هذه هي النقطة. لا دعوات جماعية، لا حسابات مزيفة.',
    },

    // Principles
    principles: {
      title: 'المبادئ',
      subtitle: 'ما يُعرّف شبكة الثقة - وما هي ليست عمداً.',
      items: [
        {
          title: 'البيانات معك',
          description: 'جميع بياناتك مشفرة على جهازك. فقط الأشخاص الذين تحققت منهم يمكنهم فك تشفيرها.',
        },
        {
          title: 'اللقاءات الحقيقية',
          description: 'كل علاقة في الشبكة تستند إلى لقاء شخصي. هذا يمنع الحسابات المزيفة والرسائل غير المرغوبة.',
        },
        {
          title: 'يعمل بدون اتصال',
          description: 'إنشاء محتوى، التحقق من الأشخاص، إعطاء شهادات - كل شيء يعمل بدون إنترنت. المزامنة تحدث لاحقاً.',
        },
        {
          title: 'مفتوح المصدر',
          description: 'الكود بالكامل عام. يمكنك التحقق من كيفية عمله وحتى المساهمة.',
        },
        {
          title: 'لديك المفتاح',
          description: 'هويتك التشفيرية ملكك. مع عبارة الاسترداد يمكنك استعادتها في أي وقت.',
        },
        {
          title: 'البيانات قابلة للتصدير',
          description: 'بدون قفل المورد. يمكنك تصدير جميع بياناتك في أي وقت.',
        },
      ],
      notTitle: {
        prefix: 'ما ليست شبكة الثقة',
        highlight: '',
        suffix: '',
      },
      notFeatures: [
        'ليست شبكة اجتماعية للتصفح',
        'لا إعلانات أو تتبع',
        'لا خوارزميات تقرر ما تراه',
        'لا بلوكتشين أو رموز مشفرة',
      ],
      note: 'هذا مشروع بحثي - نتعلم ونتحسن باستمرار',
    },

    // FAQ
    faq: {
      title: 'الأسئلة الشائعة',
      subtitle: 'إجابات على أهم الأسئلة حول شبكة الثقة.',
      moreQuestions: 'المزيد من الأسئلة؟',
      askOnGithub: 'اسأل على GitHub',
      categories: [
        {
          category: 'الأساسيات',
          questions: [
            {
              q: 'ما الذي يجعل هذا مختلفاً عن مجموعات واتساب؟',
              a: 'بياناتك تبقى معك، ليس مع ميتا. كل شيء يعمل بدون اتصال. الشهادات تبني سمعة مرئية. بدون فوضى المجموعات مع 200 رسالة غير مقروءة.',
            },
            {
              q: 'لماذا يجب أن أقابل شخصاً ما شخصياً؟',
              a: 'هذا هو جوهر المفهوم. التحقق الشخصي هو آلية مقاومة Sybil. بدونه، يمكن لأي شخص إنشاء 1000 حساب مزيف.',
            },
            {
              q: 'ماذا أرى إذا لم أتحقق من أحد؟',
              a: 'لا شيء سوى ملفك الشخصي. الشبكة بحجم علاقاتك الحقيقية فقط.',
            },
            {
              q: 'هل يمكنني دعوة أشخاص دون مقابلتهم؟',
              a: 'لا. هذا مقصود. كل علاقة في الشبكة تستند إلى لقاء حقيقي.',
            },
          ],
        },
        {
          category: 'الثقة والشهادات',
          questions: [
            {
              q: 'ما الفرق بين التحقق والشهادة؟',
              a: 'التحقق: "قابلت هذا الشخص، إنه فعلاً هو." الشهادة: "هذا الشخص فعل X / يستطيع Y." التحقق هو مرساة الهوية. الشهادات هي الثقة الفعلية.',
            },
            {
              q: 'هل يمكنني سحب شهادة؟',
              a: 'لا. الشهادات هي بيانات موقعة عن أحداث ماضية. إذا تغيرت العلاقة، ببساطة لا تنشئ جديدة.',
            },
            {
              q: 'ماذا لو أساء شخص التصرف؟',
              a: 'تُخفي الشخص. يحتفظ بشهاداته القديمة (قام بالأعمال الجيدة)، لكنك لم تعد ترى محتواه. يمكن للآخرين فعل الشيء نفسه.',
            },
          ],
        },
        {
          category: 'تقني',
          questions: [
            {
              q: 'ماذا يحدث إذا فقدت هاتفي؟',
              a: 'إذا كان لديك عبارة الاسترداد: كل شيء قابل للاسترداد. إذا لا: هويتك الرقمية فُقدت. يجب أن تبدأ من جديد وتتحقق مرة أخرى.',
            },
            {
              q: 'أين تُخزن بياناتي؟',
              a: 'محلياً على جهازك. مشفرة. فقط الأشخاص الذين تحققت منهم يمكنهم فك تشفيرها.',
            },
            {
              q: 'هل يوجد خادم؟',
              a: 'المزامنة بين الأجهزة تحتاج بنية تحتية. لكنها تخزن فقط blobs مشفرة - المشغل لا يستطيع قراءة أي شيء.',
            },
          ],
        },
        {
          category: 'التوسع والحدود',
          questions: [
            {
              q: 'ماذا لو استخدم 10,000 شخص هذا؟',
              a: 'الشبكة لا "تتوسع" بالمعنى التقليدي. ترى فقط محتوى من أشخاص تحققت منهم. مع 10,000 مستخدم، هناك العديد من الشبكات الصغيرة المتداخلة.',
            },
            {
              q: 'هل يمكنني رؤية أشخاص هم "أصدقاء أصدقاء"؟',
              a: 'في الحالة الأساسية: لا. ترى فقط محتوى من أشخاص تحققت منهم بنفسك. امتدادات لسلاسل الثقة ممكنة، لكن ليس في الخطوة الأولى.',
            },
          ],
        },
      ],
    },

    // Footer
    footer: {
      cta: {
        title: 'مستعد للعلاقات الحقيقية؟',
        subtitle: 'نبحث عن مجتمعات لتجربتها، وملاحظات حول UX والمفهوم، ومطورين للبناء معنا.',
        github: 'عرض على GitHub',
        spec: 'قراءة المواصفات',
      },
      projectTitle: 'المشروع',
      contributeTitle: 'المساهمة',
      links: {
        project: {
          concept: 'المفهوم',
          prototype: 'النموذج الأولي',
          specification: 'المواصفات',
        },
        contribute: {
          issues: 'GitHub Issues',
          feedback: 'إعطاء ملاحظات',
          code: 'المساهمة بالكود',
        },
      },
      description: 'شبكة ثقة لامركزية للمجتمعات المحلية. مشروع بحثي يضع اللقاءات الحقيقية فوق الخوارزميات.',
      license: 'مفتوح المصدر تحت رخصة MIT',
      madeWith: {
        prefix: 'صُنع بـ',
        suffix: 'للمجتمعات المحلية',
      },
    },
  },

  zh: {
    // Header
    nav: {
      concept: '概念',
      howItWorks: '工作原理',
      apps: '应用',
      personas: '适合谁？',
      faq: '常见问题',
    },

    // Hero
    hero: {
      badge: '开源研究项目',
      titleStart: '通过',
      titleHighlight: '真实相遇建立信任',
      subtitle: '一个面向本地社区的去中心化信任网络，提供自组织协作工具，数据仅与朋友和群组加密共享。',
      cta: '了解更多',
      demo: '试用演示',
      github: '在GitHub上查看',
      features: {
        verification: '亲自验证',
        encrypted: '端到端加密',
        offline: '离线可用',
      },
    },

    // ProblemSolution
    problemSolution: {
      title: '不同的方法',
      subtitle: '我们专注于本地社区而非全球平台。我们建立在真实相遇之上，而非算法。',
      today: '现在',
      better: '更好',
      problems: [
        { before: '社交媒体占据注意力', after: '在现实生活中连接' },
        { before: '你的数据在公司手中', after: '你的数据留在你身边' },
        { before: '通过点赞和星级建立信任', after: '通过真实相遇建立信任' },
        { before: '独自在屏幕前创建账户', after: '通过朋友链式加入' },
        { before: '依赖服务器和网络连接', after: '无需互联网也能工作' },
      ],
      pillarsTitle: '三大支柱',
      pillars: [
        {
          title: '验证',
          description: '通过亲自见面确认身份',
          detail: '每段关系都始于真实相遇。通过扫描二维码确认："这确实是这个人。"',
        },
        {
          title: '协作',
          description: '共享加密内容',
          detail: '与你的网络共享日历、位置和项目。全部端到端加密。',
        },
        {
          title: '证明',
          description: '通过真实行动建立声誉',
          detail: '确认他人所做的事。这些证明随时间建立可见的信任。',
        },
      ],
      note: {
        title: '验证 ≠ 信任',
        text: '验证仅确认："这确实是这个人。"真正的信任通过长期的证明来发展。',
      },
    },

    // HowItWorks
    howItWorks: {
      title: '工作原理',
      subtitle: '从第一次见面到第一次证明——进入网络的路径。',
      step: '步骤',
      steps: [
        {
          title: '扫描二维码',
          description: 'Anna和Ben见面。Ben用应用扫描Anna的二维码。',
          detail: '二维码包含Anna的公钥。Ben的应用自动创建他自己的身份。',
        },
        {
          title: '确认身份',
          description: 'Ben确认："我亲自见过Anna。"',
          detail: '这个验证被加密签名，同时交换密钥。',
        },
        {
          title: '查看内容',
          description: 'Ben现在可以看到Anna分享的内容。',
          detail: '日历、地图标记、项目——Anna与联系人分享的一切对Ben变得可解密。',
        },
        {
          title: '创建证明',
          description: '一起工作后：Anna证明Ben的帮助。',
          detail: '"Ben在花园帮忙了3小时"——这个签名声明成为Ben个人资料的一部分。',
        },
      ],
      result: {
        title: '结果',
        text: '一个不断增长的真实关系网络。每个连接都基于亲自相遇。每个证明都基于真实行动。',
      },
    },

    // Apps
    apps: {
      title: '你可以用它做什么',
      subtitle: '信任网络是信任层。各种应用建立在它之上，实现本地协作。',
      items: [
        {
          title: '地图',
          description: '找到附近的人、地点和机会。看看谁能做什么，在哪里。',
        },
        {
          title: '日历',
          description: '规划共同活动，协调日期，邀请参加活动。',
        },
        {
          title: '市场',
          description: '分享供求信息。与你信任的人交换资源。',
        },
        {
          title: '感谢',
          description: '用数字代金券说谢谢。赠送时间、帮助或感谢。',
        },
      ],
      note: {
        prefix: '所有应用都建立在',
        suffix: '之上——一个用于本地网络的模块化开源工具包。',
      },
    },

    // Personas
    personas: {
      title: '信任网络适合谁？',
      subtitle: '来自本地社区、想要建立真实联系的人。',
      needsLabel: '需求',
      howItHelpsLabel: '信任网络如何帮助',
      items: [
        {
          name: 'Hanna (62岁)',
          role: '园艺师',
          background: '活跃于社区花园，不太懂技术，主要使用WhatsApp。',
          needs: [
            '知道谁什么时候浇水',
            '找到新帮手',
            '不用处理技术问题',
          ],
          howItHelps: '她的邻居Tom设置应用并验证她。她看到花园日历，可以点击"谢谢"——这就成为一个证明。',
        },
        {
          name: 'Alexander (34岁)',
          role: '能工巧匠',
          background: '什么都能修，认识很多人，组织邻里互助。',
          needs: [
            '了解谁能做什么',
            '协调请求',
            '不要WhatsApp群混乱',
          ],
          howItHelps: '在聚会上积极验证新人。创建证明："会修自行车"，"会做电工"。在地图上看到谁提供什么。',
        },
        {
          name: 'Lena (28岁)',
          role: '怀疑者',
          background: '软件开发者，注重隐私，见过许多"去中心化"项目失败。',
          needs: [
            '了解技术原理',
            '确保数据加密',
            '无供应商锁定',
          ],
          howItHelps: '开源——可以检查代码。使用本地密钥的E2E加密。所有数据可导出。',
        },
        {
          name: 'Kowalski一家',
          role: '新来者',
          background: '刚搬到城市，不认识任何人，想找到归属感。',
          needs: [
            '认识邻居',
            '找到可信的服务',
            '成为社区的一部分',
          ],
          howItHelps: '在街头派对上首次验证。立即看到谁有证明。可以自己收集证明。',
        },
      ],
      note: '网络只能通过真实相遇增长——这需要时间，但这正是重点。没有群发邀请，没有假账户。',
    },

    // Principles
    principles: {
      title: '原则',
      subtitle: '信任网络的定义——以及它刻意不是什么。',
      items: [
        {
          title: '数据随身',
          description: '你所有的数据都加密存储在你的设备上。只有你验证过的人才能解密。',
        },
        {
          title: '真实相遇',
          description: '网络中的每段关系都基于亲自见面。这防止假账户和垃圾信息。',
        },
        {
          title: '离线可用',
          description: '创建内容、验证人员、给予证明——一切无需互联网。同步稍后进行。',
        },
        {
          title: '开源',
          description: '全部代码公开。你可以检查它如何工作，甚至可以贡献代码。',
        },
        {
          title: '你掌握密钥',
          description: '你的加密身份属于你。使用恢复短语可以随时恢复。',
        },
        {
          title: '数据可导出',
          description: '无供应商锁定。你可以随时导出所有数据。',
        },
      ],
      notTitle: {
        prefix: '信任网络',
        highlight: '不',
        suffix: '是什么',
      },
      notFeatures: [
        '不是用于刷屏的社交媒体',
        '没有广告或追踪',
        '没有算法决定你看什么',
        '没有区块链或加密代币',
      ],
      note: '这是一个研究项目——我们持续学习和改进',
    },

    // FAQ
    faq: {
      title: '常见问题',
      subtitle: '关于信任网络最重要问题的答案。',
      moreQuestions: '还有问题？',
      askOnGithub: '在GitHub上提问',
      categories: [
        {
          category: '基础',
          questions: [
            {
              q: '这和WhatsApp群有什么不同？',
              a: '你的数据留在你身边，不在Meta。一切离线可用。证明建立可见的声誉。没有200条未读消息的群混乱。',
            },
            {
              q: '为什么我必须亲自见面？',
              a: '这是概念的核心。亲自验证是Sybil抵抗机制。没有它，任何人都可以创建1000个假账户。',
            },
            {
              q: '如果我没有验证任何人，我能看到什么？',
              a: '除了你自己的个人资料什么都看不到。网络只和你的真实关系一样大。',
            },
            {
              q: '我可以邀请没见过的人吗？',
              a: '不可以。这是故意的。网络中的每段关系都基于真实相遇。',
            },
          ],
        },
        {
          category: '信任与证明',
          questions: [
            {
              q: '验证和证明有什么区别？',
              a: '验证："我见过这个人，确实是他们。" 证明："这个人做了X / 能做Y。" 验证是身份锚。证明是实际的信任。',
            },
            {
              q: '我可以撤回证明吗？',
              a: '不可以。证明是关于过去事件的签名声明。如果关系改变，你只是不再创建新的。',
            },
            {
              q: '如果有人行为不当怎么办？',
              a: '你隐藏那个人。他们保留旧的证明（他们确实做了好事），但你不再看到他们的内容。其他人也可以这样做。',
            },
          ],
        },
        {
          category: '技术',
          questions: [
            {
              q: '如果我丢了手机怎么办？',
              a: '如果你有恢复短语：一切可恢复。如果没有：你的数字身份丢失了。你必须重新开始并再次被验证。',
            },
            {
              q: '我的数据存储在哪里？',
              a: '在你的设备本地。加密的。只有你验证过的人才能解密。',
            },
            {
              q: '有服务器吗？',
              a: '设备间同步需要基础设施。但它只存储加密的数据块——运营商无法读取任何内容。',
            },
          ],
        },
        {
          category: '扩展与限制',
          questions: [
            {
              q: '如果10,000人使用这个会怎样？',
              a: '网络不会以传统方式"扩展"。你只看到你验证过的人的内容。有10,000用户时，存在许多小型重叠网络。',
            },
            {
              q: '我可以看到"朋友的朋友"吗？',
              a: '基本情况下：不能。你只看到你自己验证过的人的内容。信任链扩展是可以想象的，但不在第一步。',
            },
          ],
        },
      ],
    },

    // Footer
    footer: {
      cta: {
        title: '准备好建立真实联系了吗？',
        subtitle: '我们正在寻找愿意尝试的社区、关于UX和概念的反馈，以及愿意与我们一起构建的开发者。',
        github: '在GitHub上查看',
        spec: '阅读规范',
      },
      projectTitle: '项目',
      contributeTitle: '贡献',
      links: {
        project: {
          concept: '概念',
          prototype: '原型',
          specification: '规范',
        },
        contribute: {
          issues: 'GitHub Issues',
          feedback: '提供反馈',
          code: '贡献代码',
        },
      },
      description: '面向本地社区的去中心化信任网络。一个将真实相遇置于算法之上的研究项目。',
      license: 'MIT许可证下的开源项目',
      madeWith: {
        prefix: '用',
        suffix: '为本地社区制作',
      },
    },
  },

  ru: {
    // Header
    nav: {
      concept: 'Концепция',
      howItWorks: 'Как это работает',
      apps: 'Приложения',
      personas: 'Для кого?',
      faq: 'FAQ',
      blog: 'Blog',
    },

    // Hero
    hero: {
      badge: 'Исследовательский проект с открытым кодом',
      titleStart: 'Доверие через',
      titleHighlight: 'реальные встречи',
      subtitle: 'Децентрализованная сеть доверия для местных сообществ с инструментами для самоорганизации, где данные передаются только в зашифрованном виде друзьям и группам.',
      cta: 'Узнать больше',
      demo: 'Попробовать демо',
      github: 'Смотреть на GitHub',
      features: {
        verification: 'Личная верификация',
        encrypted: 'Сквозное шифрование',
        offline: 'Работает офлайн',
      },
    },

    // ProblemSolution
    problemSolution: {
      title: 'Другой подход',
      subtitle: 'Мы фокусируемся на местных сообществах вместо глобальных платформ. Вместо алгоритмов мы строим на реальных встречах.',
      today: 'Сегодня',
      better: 'Лучше',
      problems: [
        { before: 'Соцсети захватывают внимание', after: 'Связь в реальной жизни' },
        { before: 'Ваши данные у корпораций', after: 'Ваши данные остаются с вами' },
        { before: 'Доверие через лайки и звёзды', after: 'Доверие через реальные встречи' },
        { before: 'Создание аккаунта в одиночку перед экраном', after: 'Присоединение через друзей по цепочке' },
        { before: 'Зависимость от серверов и связи', after: 'Работает без интернета' },
      ],
      pillarsTitle: 'Три столпа',
      pillars: [
        {
          title: 'Верифицировать',
          description: 'Подтвердить личность при личной встрече',
          detail: 'Каждые отношения начинаются с реальной встречи. Сканируя QR-код, вы подтверждаете: "Это действительно этот человек."',
        },
        {
          title: 'Сотрудничать',
          description: 'Делиться зашифрованным контентом',
          detail: 'Делитесь календарями, местоположениями и проектами с вашей сетью. Всё зашифровано сквозным шифрованием.',
        },
        {
          title: 'Подтверждать',
          description: 'Строить репутацию через реальные действия',
          detail: 'Подтверждайте, что сделали другие. Эти подтверждения создают видимое доверие со временем.',
        },
      ],
      note: {
        title: 'Верификация ≠ Доверие',
        text: 'Верификация только подтверждает: "Это действительно этот человек." Настоящее доверие развивается через подтверждения со временем.',
      },
    },

    // HowItWorks
    howItWorks: {
      title: 'Как это работает',
      subtitle: 'От первой встречи до первого подтверждения — путь в сеть.',
      step: 'Шаг',
      steps: [
        {
          title: 'Сканировать QR-код',
          description: 'Анна и Бен встречаются. Бен сканирует QR-код Анны приложением.',
          detail: 'QR-код содержит публичный ключ Анны. Приложение Бена автоматически создаёт его собственную личность.',
        },
        {
          title: 'Подтвердить личность',
          description: 'Бен подтверждает: "Я лично встретил Анну."',
          detail: 'Эта верификация криптографически подписана, и ключи обмениваются одновременно.',
        },
        {
          title: 'Видеть контент',
          description: 'Бен теперь может видеть контент Анны.',
          detail: 'Календарь, метки на карте, проекты — всё, чем Анна делится с контактами, становится расшифровываемым для Бена.',
        },
        {
          title: 'Создать подтверждение',
          description: 'После совместной работы: Анна подтверждает помощь Бена.',
          detail: '"Бен помог 3 часа в саду" — это подписанное заявление становится частью профиля Бена.',
        },
      ],
      result: {
        title: 'Результат',
        text: 'Растущая сеть реальных отношений. Каждая связь основана на личной встрече. Каждое подтверждение на реальном действии.',
      },
    },

    // Apps
    apps: {
      title: 'Что вы можете делать с этим',
      subtitle: 'Web of Trust — это слой доверия. Различные приложения строятся на нём для обеспечения местного сотрудничества.',
      items: [
        {
          title: 'Карта',
          description: 'Находите людей, места и предложения поблизости. Смотрите, кто что умеет и где.',
        },
        {
          title: 'Календарь',
          description: 'Планируйте совместные мероприятия, координируйте даты и приглашайте на события.',
        },
        {
          title: 'Маркетплейс',
          description: 'Делитесь предложениями и запросами. Обменивайтесь ресурсами с людьми, которым доверяете.',
        },
        {
          title: 'Благодарность',
          description: 'Говорите спасибо цифровыми ваучерами. Дарите время, помощь или благодарность.',
        },
      ],
      note: {
        prefix: 'Все приложения построены на',
        suffix: '— модульном инструментарии с открытым кодом для местных сетей.',
      },
    },

    // Personas
    personas: {
      title: 'Для кого Web of Trust?',
      subtitle: 'Люди из местных сообществ, которые хотят строить реальные связи.',
      needsLabel: 'Потребности',
      howItHelpsLabel: 'Как помогает Web of Trust',
      items: [
        {
          name: 'Ханна (62)',
          role: 'Садовница',
          background: 'Активна в общественном саду, не разбирается в технологиях, использует в основном WhatsApp.',
          needs: [
            'Знать, кто когда поливает',
            'Найти новых помощников',
            'Не разбираться с технологиями',
          ],
          howItHelps: 'Её сосед Том настраивает приложение и верифицирует её. Она видит календарь сада и может нажать "Спасибо" — это становится подтверждением.',
        },
        {
          name: 'Александр (34)',
          role: 'Мастер',
          background: 'Может починить что угодно, знает много людей, организует соседскую помощь.',
          needs: [
            'Обзор, кто что умеет',
            'Координировать запросы',
            'Без хаоса групп WhatsApp',
          ],
          howItHelps: 'Активно верифицирует новых людей на встречах. Создаёт подтверждения: "Может чинить велосипеды", "Может делать электрику". Видит на карте, кто что предлагает.',
        },
        {
          name: 'Лена (28)',
          role: 'Скептик',
          background: 'Разработчик ПО, заботится о приватности, видела, как многие "децентрализованные" проекты терпели неудачу.',
          needs: [
            'Понять, как это работает технически',
            'Убедиться, что данные зашифрованы',
            'Без привязки к поставщику',
          ],
          howItHelps: 'Открытый код — можно проверить. E2E шифрование с локальными ключами. Все данные экспортируемы.',
        },
        {
          name: 'Семья Ковальски',
          role: 'Новоприбывшие',
          background: 'Новые в городе, никого не знают, хотят найти связь.',
          needs: [
            'Познакомиться с соседями',
            'Найти надёжные предложения',
            'Стать частью сообщества',
          ],
          howItHelps: 'Первые верификации на уличном фестивале. Сразу видят, у кого есть подтверждения. Могут сами собирать подтверждения.',
        },
      ],
      note: 'Сеть растёт только через реальные встречи — это требует времени, но в этом суть. Никаких массовых приглашений, никаких фейковых аккаунтов.',
    },

    // Principles
    principles: {
      title: 'Принципы',
      subtitle: 'Что определяет Web of Trust — и чем он намеренно не является.',
      items: [
        {
          title: 'Данные с вами',
          description: 'Все ваши данные зашифрованы на вашем устройстве. Только люди, которых вы верифицировали, могут их расшифровать.',
        },
        {
          title: 'Реальные встречи',
          description: 'Каждые отношения в сети основаны на личной встрече. Это предотвращает фейковые аккаунты и спам.',
        },
        {
          title: 'Работает офлайн',
          description: 'Создавать контент, верифицировать людей, давать подтверждения — всё работает без интернета. Синхронизация происходит позже.',
        },
        {
          title: 'Открытый код',
          description: 'Весь код публичен. Вы можете проверить, как это работает, и даже внести вклад.',
        },
        {
          title: 'У вас есть ключ',
          description: 'Ваша криптографическая личность принадлежит вам. С фразой восстановления вы можете восстановить её в любое время.',
        },
        {
          title: 'Данные экспортируемы',
          description: 'Без привязки к поставщику. Вы можете экспортировать все свои данные в любое время.',
        },
      ],
      notTitle: {
        prefix: 'Чем Web of Trust',
        highlight: 'не',
        suffix: 'является',
      },
      notFeatures: [
        'Не соцсеть для листания',
        'Без рекламы или отслеживания',
        'Без алгоритмов, решающих, что вы видите',
        'Без блокчейна или криптотокенов',
      ],
      note: 'Это исследовательский проект — мы постоянно учимся и улучшаемся',
    },

    // FAQ
    faq: {
      title: 'Часто задаваемые вопросы',
      subtitle: 'Ответы на самые важные вопросы о Web of Trust.',
      moreQuestions: 'Ещё вопросы?',
      askOnGithub: 'Спросить на GitHub',
      categories: [
        {
          category: 'Основы',
          questions: [
            {
              q: 'Чем это отличается от групп WhatsApp?',
              a: 'Ваши данные остаются с вами, не с Meta. Всё работает офлайн. Подтверждения строят видимую репутацию. Без хаоса групп с 200 непрочитанными сообщениями.',
            },
            {
              q: 'Почему я должен встретиться с кем-то лично?',
              a: 'Это суть концепции. Личная верификация — это механизм защиты от Сибил-атак. Без неё любой мог бы создать 1000 фейковых аккаунтов.',
            },
            {
              q: 'Что я вижу, если никого не верифицировал?',
              a: 'Ничего, кроме своего профиля. Сеть только такая большая, как ваши реальные отношения.',
            },
            {
              q: 'Могу ли я приглашать людей, не встречаясь с ними?',
              a: 'Нет. Это намеренно. Каждые отношения в сети основаны на реальной встрече.',
            },
          ],
        },
        {
          category: 'Доверие и подтверждения',
          questions: [
            {
              q: 'В чём разница между верификацией и подтверждением?',
              a: 'Верификация: "Я встретил этого человека, это действительно он." Подтверждение: "Этот человек сделал X / умеет Y." Верификация — это якорь личности. Подтверждения — это реальное доверие.',
            },
            {
              q: 'Могу ли я отозвать подтверждение?',
              a: 'Нет. Подтверждения — это подписанные заявления о прошлых событиях. Если отношения меняются, вы просто не создаёте новые.',
            },
            {
              q: 'Что если кто-то плохо себя ведёт?',
              a: 'Вы скрываете человека. Он сохраняет старые подтверждения (он действительно делал хорошие дела), но вы больше не видите его контент. Другие могут сделать то же самое.',
            },
          ],
        },
        {
          category: 'Техническое',
          questions: [
            {
              q: 'Что если я потеряю телефон?',
              a: 'Если у вас есть фраза восстановления: Всё восстановимо. Если нет: Ваша цифровая личность потеряна. Вам придётся начать заново и снова пройти верификацию.',
            },
            {
              q: 'Где хранятся мои данные?',
              a: 'Локально на вашем устройстве. Зашифрованы. Только люди, которых вы верифицировали, могут их расшифровать.',
            },
            {
              q: 'Есть ли сервер?',
              a: 'Синхронизация между устройствами требует инфраструктуры. Но она хранит только зашифрованные данные — оператор не может ничего прочитать.',
            },
          ],
        },
        {
          category: 'Масштабирование и ограничения',
          questions: [
            {
              q: 'Что если 10 000 человек будут это использовать?',
              a: 'Сеть не "масштабируется" в традиционном смысле. Вы видите только контент людей, которых верифицировали. При 10 000 пользователей существует множество маленьких пересекающихся сетей.',
            },
            {
              q: 'Могу ли я видеть людей, которые являются "друзьями друзей"?',
              a: 'В базовом случае: Нет. Вы видите только контент людей, которых сами верифицировали. Расширения для цепочек доверия возможны, но не на первом этапе.',
            },
          ],
        },
      ],
    },

    // Footer
    footer: {
      cta: {
        title: 'Готовы к реальным связям?',
        subtitle: 'Мы ищем сообщества для тестирования, отзывы о UX и концепции, и разработчиков для совместной работы.',
        github: 'Смотреть на GitHub',
        spec: 'Читать спецификацию',
      },
      projectTitle: 'Проект',
      contributeTitle: 'Участвовать',
      links: {
        project: {
          concept: 'Концепция',
          prototype: 'Прототип',
          specification: 'Спецификация',
        },
        contribute: {
          issues: 'GitHub Issues',
          feedback: 'Оставить отзыв',
          code: 'Внести код',
        },
      },
      description: 'Децентрализованная сеть доверия для местных сообществ. Исследовательский проект, ставящий реальные встречи выше алгоритмов.',
      license: 'Открытый код под лицензией MIT',
      madeWith: {
        prefix: 'Сделано с',
        suffix: 'для местных сообществ',
      },
    },
  },

  uk: {
    // Header
    nav: {
      concept: 'Концепція',
      howItWorks: 'Як це працює',
      apps: 'Додатки',
      personas: 'Для кого?',
      faq: 'FAQ',
      blog: 'Blog',
    },

    // Hero
    hero: {
      badge: 'Дослідницький проєкт з відкритим кодом',
      titleStart: 'Довіра через',
      titleHighlight: 'реальні зустрічі',
      subtitle: 'Децентралізована мережа довіри для місцевих спільнот з інструментами для самоорганізації, де дані передаються лише в зашифрованому вигляді друзям і групам.',
      cta: 'Дізнатися більше',
      demo: 'Спробувати демо',
      github: 'Дивитися на GitHub',
      features: {
        verification: 'Особиста верифікація',
        encrypted: 'Наскрізне шифрування',
        offline: 'Працює офлайн',
      },
    },

    // ProblemSolution
    problemSolution: {
      title: 'Інший підхід',
      subtitle: 'Ми фокусуємося на місцевих спільнотах замість глобальних платформ. Замість алгоритмів ми будуємо на реальних зустрічах.',
      today: 'Сьогодні',
      better: 'Краще',
      problems: [
        { before: 'Соцмережі захоплюють увагу', after: 'Зв\'язок у реальному житті' },
        { before: 'Ваші дані у корпорацій', after: 'Ваші дані залишаються з вами' },
        { before: 'Довіра через лайки та зірочки', after: 'Довіра через реальні зустрічі' },
        { before: 'Створення акаунту на самоті перед екраном', after: 'Приєднання через друзів по ланцюжку' },
        { before: 'Залежність від серверів та зв\'язку', after: 'Працює без інтернету' },
      ],
      pillarsTitle: 'Три стовпи',
      pillars: [
        {
          title: 'Верифікувати',
          description: 'Підтвердити особу при особистій зустрічі',
          detail: 'Кожні стосунки починаються з реальної зустрічі. Скануючи QR-код, ви підтверджуєте: "Це дійсно ця людина."',
        },
        {
          title: 'Співпрацювати',
          description: 'Ділитися зашифрованим контентом',
          detail: 'Діліться календарями, місцями та проєктами зі своєю мережею. Все зашифровано наскрізним шифруванням.',
        },
        {
          title: 'Підтверджувати',
          description: 'Будувати репутацію через реальні дії',
          detail: 'Підтверджуйте, що зробили інші. Ці підтвердження створюють видиму довіру з часом.',
        },
      ],
      note: {
        title: 'Верифікація ≠ Довіра',
        text: 'Верифікація лише підтверджує: "Це дійсно ця людина." Справжня довіра розвивається через підтвердження з часом.',
      },
    },

    // HowItWorks
    howItWorks: {
      title: 'Як це працює',
      subtitle: 'Від першої зустрічі до першого підтвердження — шлях до мережі.',
      step: 'Крок',
      steps: [
        {
          title: 'Сканувати QR-код',
          description: 'Анна і Бен зустрічаються. Бен сканує QR-код Анни додатком.',
          detail: 'QR-код містить публічний ключ Анни. Додаток Бена автоматично створює його власну особистість.',
        },
        {
          title: 'Підтвердити особу',
          description: 'Бен підтверджує: "Я особисто зустрів Анну."',
          detail: 'Ця верифікація криптографічно підписана, і ключі обмінюються одночасно.',
        },
        {
          title: 'Бачити контент',
          description: 'Бен тепер може бачити контент Анни.',
          detail: 'Календар, мітки на карті, проєкти — все, чим Анна ділиться з контактами, стає розшифровуваним для Бена.',
        },
        {
          title: 'Створити підтвердження',
          description: 'Після спільної роботи: Анна підтверджує допомогу Бена.',
          detail: '"Бен допоміг 3 години в саду" — ця підписана заява стає частиною профілю Бена.',
        },
      ],
      result: {
        title: 'Результат',
        text: 'Зростаюча мережа реальних стосунків. Кожен зв\'язок базується на особистій зустрічі. Кожне підтвердження на реальній дії.',
      },
    },

    // Apps
    apps: {
      title: 'Що ви можете робити з цим',
      subtitle: 'Web of Trust — це рівень довіри. Різні додатки будуються на ньому для забезпечення місцевої співпраці.',
      items: [
        {
          title: 'Карта',
          description: 'Знаходьте людей, місця та пропозиції поблизу. Дивіться, хто що вміє і де.',
        },
        {
          title: 'Календар',
          description: 'Плануйте спільні заходи, координуйте дати та запрошуйте на події.',
        },
        {
          title: 'Маркетплейс',
          description: 'Діліться пропозиціями та запитами. Обмінюйтесь ресурсами з людьми, яким довіряєте.',
        },
        {
          title: 'Вдячність',
          description: 'Кажіть дякую цифровими ваучерами. Даруйте час, допомогу або подяку.',
        },
      ],
      note: {
        prefix: 'Всі додатки побудовані на',
        suffix: '— модульному інструментарії з відкритим кодом для місцевих мереж.',
      },
    },

    // Personas
    personas: {
      title: 'Для кого Web of Trust?',
      subtitle: 'Люди з місцевих спільнот, які хочуть будувати реальні зв\'язки.',
      needsLabel: 'Потреби',
      howItHelpsLabel: 'Як допомагає Web of Trust',
      items: [
        {
          name: 'Ганна (62)',
          role: 'Садівниця',
          background: 'Активна в громадському саду, не розбирається в технологіях, використовує переважно WhatsApp.',
          needs: [
            'Знати, хто коли поливає',
            'Знайти нових помічників',
            'Не розбиратися з технологіями',
          ],
          howItHelps: 'Її сусід Том налаштовує додаток і верифікує її. Вона бачить календар саду і може натиснути "Дякую" — це стає підтвердженням.',
        },
        {
          name: 'Олександр (34)',
          role: 'Майстер',
          background: 'Може полагодити будь-що, знає багато людей, організовує сусідську допомогу.',
          needs: [
            'Огляд, хто що вміє',
            'Координувати запити',
            'Без хаосу груп WhatsApp',
          ],
          howItHelps: 'Активно верифікує нових людей на зустрічах. Створює підтвердження: "Може лагодити велосипеди", "Може робити електрику". Бачить на карті, хто що пропонує.',
        },
        {
          name: 'Лєна (28)',
          role: 'Скептик',
          background: 'Розробниця ПЗ, дбає про приватність, бачила, як багато "децентралізованих" проєктів зазнавали невдачі.',
          needs: [
            'Зрозуміти, як це працює технічно',
            'Переконатися, що дані зашифровані',
            'Без прив\'язки до постачальника',
          ],
          howItHelps: 'Відкритий код — можна перевірити. E2E шифрування з локальними ключами. Всі дані експортовані.',
        },
        {
          name: 'Сім\'я Ковальських',
          role: 'Новоприбулі',
          background: 'Нові в місті, нікого не знають, хочуть знайти зв\'язок.',
          needs: [
            'Познайомитися з сусідами',
            'Знайти надійні пропозиції',
            'Стати частиною спільноти',
          ],
          howItHelps: 'Перші верифікації на вуличному фестивалі. Одразу бачать, у кого є підтвердження. Можуть самі збирати підтвердження.',
        },
      ],
      note: 'Мережа зростає тільки через реальні зустрічі — це вимагає часу, але в цьому суть. Ніяких масових запрошень, ніяких фейкових акаунтів.',
    },

    // Principles
    principles: {
      title: 'Принципи',
      subtitle: 'Що визначає Web of Trust — і чим він навмисно не є.',
      items: [
        {
          title: 'Дані з вами',
          description: 'Всі ваші дані зашифровані на вашому пристрої. Тільки люди, яких ви верифікували, можуть їх розшифрувати.',
        },
        {
          title: 'Реальні зустрічі',
          description: 'Кожні стосунки в мережі базуються на особистій зустрічі. Це запобігає фейковим акаунтам і спаму.',
        },
        {
          title: 'Працює офлайн',
          description: 'Створювати контент, верифікувати людей, давати підтвердження — все працює без інтернету. Синхронізація відбувається пізніше.',
        },
        {
          title: 'Відкритий код',
          description: 'Весь код публічний. Ви можете перевірити, як це працює, і навіть зробити внесок.',
        },
        {
          title: 'У вас є ключ',
          description: 'Ваша криптографічна особистість належить вам. З фразою відновлення ви можете відновити її в будь-який час.',
        },
        {
          title: 'Дані експортовані',
          description: 'Без прив\'язки до постачальника. Ви можете експортувати всі свої дані в будь-який час.',
        },
      ],
      notTitle: {
        prefix: 'Чим Web of Trust',
        highlight: 'не',
        suffix: 'є',
      },
      notFeatures: [
        'Не соцмережа для гортання',
        'Без реклами чи відстеження',
        'Без алгоритмів, що вирішують, що ви бачите',
        'Без блокчейну чи криптотокенів',
      ],
      note: 'Це дослідницький проєкт — ми постійно вчимося та вдосконалюємося',
    },

    // FAQ
    faq: {
      title: 'Часті запитання',
      subtitle: 'Відповіді на найважливіші запитання про Web of Trust.',
      moreQuestions: 'Ще запитання?',
      askOnGithub: 'Запитати на GitHub',
      categories: [
        {
          category: 'Основи',
          questions: [
            {
              q: 'Чим це відрізняється від груп WhatsApp?',
              a: 'Ваші дані залишаються з вами, не з Meta. Все працює офлайн. Підтвердження будують видиму репутацію. Без хаосу груп з 200 непрочитаними повідомленнями.',
            },
            {
              q: 'Чому я маю зустрітися з кимось особисто?',
              a: 'Це суть концепції. Особиста верифікація — це механізм захисту від Сібіл-атак. Без неї будь-хто міг би створити 1000 фейкових акаунтів.',
            },
            {
              q: 'Що я бачу, якщо нікого не верифікував?',
              a: 'Нічого, крім свого профілю. Мережа лише така велика, як ваші реальні стосунки.',
            },
            {
              q: 'Чи можу я запрошувати людей, не зустрічаючись з ними?',
              a: 'Ні. Це навмисно. Кожні стосунки в мережі базуються на реальній зустрічі.',
            },
          ],
        },
        {
          category: 'Довіра та підтвердження',
          questions: [
            {
              q: 'Яка різниця між верифікацією та підтвердженням?',
              a: 'Верифікація: "Я зустрів цю людину, це дійсно вона." Підтвердження: "Ця людина зробила X / вміє Y." Верифікація — це якір особистості. Підтвердження — це реальна довіра.',
            },
            {
              q: 'Чи можу я відкликати підтвердження?',
              a: 'Ні. Підтвердження — це підписані заяви про минулі події. Якщо стосунки змінюються, ви просто не створюєте нові.',
            },
            {
              q: 'Що якщо хтось погано себе поводить?',
              a: 'Ви приховуєте людину. Вона зберігає старі підтвердження (вона дійсно робила добрі справи), але ви більше не бачите її контент. Інші можуть зробити те саме.',
            },
          ],
        },
        {
          category: 'Технічне',
          questions: [
            {
              q: 'Що якщо я втрачу телефон?',
              a: 'Якщо у вас є фраза відновлення: Все відновлювано. Якщо ні: Ваша цифрова особистість втрачена. Вам доведеться почати заново і знову пройти верифікацію.',
            },
            {
              q: 'Де зберігаються мої дані?',
              a: 'Локально на вашому пристрої. Зашифровані. Тільки люди, яких ви верифікували, можуть їх розшифрувати.',
            },
            {
              q: 'Чи є сервер?',
              a: 'Синхронізація між пристроями потребує інфраструктури. Але вона зберігає лише зашифровані дані — оператор не може нічого прочитати.',
            },
          ],
        },
        {
          category: 'Масштабування та обмеження',
          questions: [
            {
              q: 'Що якщо 10 000 людей будуть це використовувати?',
              a: 'Мережа не "масштабується" в традиційному сенсі. Ви бачите лише контент людей, яких верифікували. При 10 000 користувачів існує багато маленьких мереж, що перетинаються.',
            },
            {
              q: 'Чи можу я бачити людей, які є "друзями друзів"?',
              a: 'У базовому випадку: Ні. Ви бачите лише контент людей, яких самі верифікували. Розширення для ланцюжків довіри можливі, але не на першому етапі.',
            },
          ],
        },
      ],
    },

    // Footer
    footer: {
      cta: {
        title: 'Готові до реальних зв\'язків?',
        subtitle: 'Ми шукаємо спільноти для тестування, відгуки про UX та концепцію, і розробників для спільної роботи.',
        github: 'Дивитися на GitHub',
        spec: 'Читати специфікацію',
      },
      projectTitle: 'Проєкт',
      contributeTitle: 'Долучитися',
      links: {
        project: {
          concept: 'Концепція',
          prototype: 'Прототип',
          specification: 'Специфікація',
        },
        contribute: {
          issues: 'GitHub Issues',
          feedback: 'Залишити відгук',
          code: 'Зробити внесок кодом',
        },
      },
      description: 'Децентралізована мережа довіри для місцевих спільнот. Дослідницький проєкт, що ставить реальні зустрічі вище алгоритмів.',
      license: 'Відкритий код під ліцензією MIT',
      madeWith: {
        prefix: 'Зроблено з',
        suffix: 'для місцевих спільнот',
      },
    },
  },

  he: {
    // Header
    nav: {
      concept: 'קונספט',
      howItWorks: 'איך זה עובד',
      apps: 'אפליקציות',
      personas: 'למי זה?',
      faq: 'שאלות נפוצות',
    },

    // Hero
    hero: {
      badge: 'פרויקט מחקר קוד פתוח',
      titleStart: 'אמון דרך',
      titleHighlight: 'מפגשים אמיתיים',
      subtitle: 'רשת אמון מבוזרת לקהילות מקומיות עם כלים לשיתוף פעולה עצמי שבה מידע משותף רק מוצפן עם חברים וקבוצות.',
      cta: 'למד עוד',
      demo: 'נסה את הדמו',
      github: 'צפה ב-GitHub',
      features: {
        verification: 'אימות אישי',
        encrypted: 'הצפנה מקצה לקצה',
        offline: 'עובד אופליין',
      },
    },

    // ProblemSolution
    problemSolution: {
      title: 'גישה שונה',
      subtitle: 'אנחנו מתמקדים בקהילות מקומיות במקום פלטפורמות גלובליות. במקום אלגוריתמים, אנחנו בונים על מפגשים אמיתיים.',
      today: 'היום',
      better: 'יותר טוב',
      problems: [
        { before: 'רשתות חברתיות לוכדות תשומת לב', after: 'התחברות בחיים האמיתיים' },
        { before: 'המידע שלך אצל תאגידים', after: 'המידע שלך נשאר איתך' },
        { before: 'אמון דרך לייקים וכוכבים', after: 'אמון דרך מפגשים אמיתיים' },
        { before: 'יצירת חשבון לבד מול המסך', after: 'הצטרפות דרך חברים בשרשרת' },
        { before: 'תלות בשרתים וקישוריות', after: 'עובד בלי אינטרנט' },
      ],
      pillarsTitle: 'שלושת העמודים',
      pillars: [
        {
          title: 'לאמת',
          description: 'לאשר זהות במפגש אישי',
          detail: 'כל יחס מתחיל במפגש אמיתי. בסריקת קוד QR אתה מאשר: "זה באמת האדם הזה."',
        },
        {
          title: 'לשתף פעולה',
          description: 'לשתף תוכן מוצפן',
          detail: 'שתף לוחות שנה, מיקומים ופרויקטים עם הרשת שלך. הכל מוצפן מקצה לקצה.',
        },
        {
          title: 'להעיד',
          description: 'לבנות מוניטין דרך מעשים אמיתיים',
          detail: 'אשר מה שאחרים עשו. העדויות האלה בונות אמון נראה עם הזמן.',
        },
      ],
      note: {
        title: 'אימות ≠ אמון',
        text: 'אימות רק מאשר: "זה באמת האדם הזה." אמון אמיתי מתפתח דרך עדויות עם הזמן.',
      },
    },

    // HowItWorks
    howItWorks: {
      title: 'איך זה עובד',
      subtitle: 'מהמפגש הראשון לעדות הראשונה - הדרך לרשת.',
      step: 'שלב',
      steps: [
        {
          title: 'סרוק קוד QR',
          description: 'אנה ובן נפגשים. בן סורק את קוד ה-QR של אנה עם האפליקציה.',
          detail: 'קוד ה-QR מכיל את המפתח הציבורי של אנה. האפליקציה של בן יוצרת אוטומטית את הזהות שלו.',
        },
        {
          title: 'אשר זהות',
          description: 'בן מאשר: "פגשתי את אנה באופן אישי."',
          detail: 'האימות הזה נחתם קריפטוגרפית ומפתחות מוחלפים בו-זמנית.',
        },
        {
          title: 'צפה בתוכן',
          description: 'בן יכול עכשיו לראות את התוכן שאנה משתפת.',
          detail: 'לוח שנה, סמנים במפה, פרויקטים - כל מה שאנה משתפת עם אנשי הקשר שלה הופך לניתן לפענוח עבור בן.',
        },
        {
          title: 'צור עדות',
          description: 'אחרי עבודה משותפת: אנה מעידה על העזרה של בן.',
          detail: '"בן עזר 3 שעות בגינה" - ההצהרה החתומה הזו הופכת לחלק מהפרופיל של בן.',
        },
      ],
      result: {
        title: 'התוצאה',
        text: 'רשת גדלה של יחסים אמיתיים. כל חיבור מבוסס על מפגש אישי. כל עדות על מעשה אמיתי.',
      },
    },

    // Apps
    apps: {
      title: 'מה אפשר לעשות עם זה',
      subtitle: 'Web of Trust היא שכבת האמון. אפליקציות שונות נבנות עליה כדי לאפשר שיתוף פעולה מקומי.',
      items: [
        {
          title: 'מפה',
          description: 'מצא אנשים, מקומות והצעות בקרבת מקום. ראה מי יכול לעשות מה והיכן.',
        },
        {
          title: 'לוח שנה',
          description: 'תכנן פעילויות משותפות, תאם תאריכים והזמן לאירועים.',
        },
        {
          title: 'שוק',
          description: 'שתף הצעות ובקשות. החלף משאבים עם אנשים שאתה סומך עליהם.',
        },
        {
          title: 'הערכה',
          description: 'אמור תודה עם שוברים דיגיטליים. תן זמן, עזרה או תודה.',
        },
      ],
      note: {
        prefix: 'כל האפליקציות בנויות על',
        suffix: '– ערכת כלים מודולרית בקוד פתוח לרשתות מקומיות.',
      },
    },

    // Personas
    personas: {
      title: 'למי מיועד Web of Trust?',
      subtitle: 'אנשים מקהילות מקומיות שרוצים לבנות קשרים אמיתיים.',
      needsLabel: 'צרכים',
      howItHelpsLabel: 'איך Web of Trust עוזר',
      items: [
        {
          name: 'חנה (62)',
          role: 'הגננית',
          background: 'פעילה בגינה הקהילתית, לא מתמצאת בטכנולוגיה, משתמשת בעיקר בוואטסאפ.',
          needs: [
            'לדעת מי משקה מתי',
            'למצוא עוזרים חדשים',
            'לא להתעסק עם טכנולוגיה',
          ],
          howItHelps: 'השכן שלה תום מגדיר את האפליקציה ומאמת אותה. היא רואה את לוח השנה של הגינה ויכולה ללחוץ "תודה" - זה הופך לעדות.',
        },
        {
          name: 'אלכסנדר (34)',
          role: 'איש העשייה',
          background: 'יכול לתקן הכל, מכיר הרבה אנשים, מארגן עזרה שכונתית.',
          needs: [
            'סקירה של מי יכול לעשות מה',
            'לתאם בקשות',
            'בלי כאוס קבוצות וואטסאפ',
          ],
          howItHelps: 'מאמת באופן פעיל אנשים חדשים במפגשים. יוצר עדויות: "יכול לתקן אופניים", "יכול לעשות חשמל". רואה במפה מי מציע מה.',
        },
        {
          name: 'לנה (28)',
          role: 'הספקנית',
          background: 'מפתחת תוכנה, מודעת לפרטיות, ראתה הרבה פרויקטים "מבוזרים" נכשלים.',
          needs: [
            'להבין איך זה עובד טכנית',
            'להיות בטוחה שהמידע מוצפן',
            'בלי נעילה לספק',
          ],
          howItHelps: 'קוד פתוח - יכולה לבדוק את הקוד. הצפנה E2E עם מפתחות מקומיים. כל המידע ניתן לייצוא.',
        },
        {
          name: 'משפחת קובלסקי',
          role: 'החדשים',
          background: 'חדשים בעיר, לא מכירים אף אחד, רוצים למצוא קשר.',
          needs: [
            'להכיר שכנים',
            'למצוא הצעות אמינות',
            'להיות חלק מקהילה',
          ],
          howItHelps: 'אימותים ראשונים בפסטיבל הרחוב. רואים מיד למי יש עדויות. יכולים לאסוף עדויות בעצמם.',
        },
      ],
      note: 'הרשת גדלה רק דרך מפגשים אמיתיים - זה לוקח זמן, אבל זו הנקודה. בלי הזמנות המוניות, בלי חשבונות מזויפים.',
    },

    // Principles
    principles: {
      title: 'העקרונות',
      subtitle: 'מה מגדיר את Web of Trust - ומה היא במכוון לא.',
      items: [
        {
          title: 'מידע איתך',
          description: 'כל המידע שלך מוצפן על המכשיר שלך. רק אנשים שאימתת יכולים לפענח אותו.',
        },
        {
          title: 'מפגשים אמיתיים',
          description: 'כל יחס ברשת מבוסס על מפגש אישי. זה מונע חשבונות מזויפים וספאם.',
        },
        {
          title: 'עובד אופליין',
          description: 'ליצור תוכן, לאמת אנשים, לתת עדויות - הכל עובד בלי אינטרנט. סנכרון קורה אחר כך.',
        },
        {
          title: 'קוד פתוח',
          description: 'כל הקוד ציבורי. אתה יכול לבדוק איך זה עובד ואפילו לתרום.',
        },
        {
          title: 'יש לך את המפתח',
          description: 'הזהות הקריפטוגרפית שלך שייכת לך. עם משפט השחזור אתה יכול לשחזר אותה בכל עת.',
        },
        {
          title: 'מידע ניתן לייצוא',
          description: 'בלי נעילה לספק. אתה יכול לייצא את כל המידע שלך בכל עת.',
        },
      ],
      notTitle: {
        prefix: 'מה Web of Trust',
        highlight: 'לא',
        suffix: '',
      },
      notFeatures: [
        'לא רשת חברתית לגלילה',
        'בלי פרסומות או מעקב',
        'בלי אלגוריתמים שמחליטים מה אתה רואה',
        'בלי בלוקצ\'יין או טוקנים קריפטו',
      ],
      note: 'זהו פרויקט מחקר - אנחנו לומדים ומשתפרים כל הזמן',
    },

    // FAQ
    faq: {
      title: 'שאלות נפוצות',
      subtitle: 'תשובות לשאלות החשובות ביותר על Web of Trust.',
      moreQuestions: 'עוד שאלות?',
      askOnGithub: 'שאל ב-GitHub',
      categories: [
        {
          category: 'יסודות',
          questions: [
            {
              q: 'מה מבדיל את זה מקבוצות וואטסאפ?',
              a: 'המידע שלך נשאר איתך, לא עם מטא. הכל עובד אופליין. עדויות בונות מוניטין נראה. בלי כאוס קבוצות עם 200 הודעות שלא נקראו.',
            },
            {
              q: 'למה אני צריך לפגוש מישהו באופן אישי?',
              a: 'זה הליבה של הקונספט. אימות אישי הוא מנגנון ההתנגדות ל-Sybil. בלעדיו, כל אחד יכול ליצור 1000 חשבונות מזויפים.',
            },
            {
              q: 'מה אני רואה אם לא אימתתי אף אחד?',
              a: 'כלום חוץ מהפרופיל שלך. הרשת גדולה רק כמו היחסים האמיתיים שלך.',
            },
            {
              q: 'האם אני יכול להזמין אנשים בלי לפגוש אותם?',
              a: 'לא. זה מכוון. כל יחס ברשת מבוסס על מפגש אמיתי.',
            },
          ],
        },
        {
          category: 'אמון ועדויות',
          questions: [
            {
              q: 'מה ההבדל בין אימות לעדות?',
              a: 'אימות: "פגשתי את האדם הזה, זה באמת הוא." עדות: "האדם הזה עשה X / יכול Y." אימות הוא עוגן הזהות. עדויות הן האמון האמיתי.',
            },
            {
              q: 'האם אני יכול לבטל עדות?',
              a: 'לא. עדויות הן הצהרות חתומות על אירועים שקרו. אם היחס משתנה, פשוט לא יוצרים חדשות.',
            },
            {
              q: 'מה אם מישהו מתנהג רע?',
              a: 'אתה מסתיר את האדם. הוא שומר את העדויות הישנות שלו (הוא באמת עשה את המעשים הטובים), אבל אתה כבר לא רואה את התוכן שלו. אחרים יכולים לעשות אותו דבר.',
            },
          ],
        },
        {
          category: 'טכני',
          questions: [
            {
              q: 'מה קורה אם אני מאבד את הטלפון?',
              a: 'אם יש לך את משפט השחזור: הכל ניתן לשחזור. אם לא: הזהות הדיגיטלית שלך אבדה. אתה צריך להתחיל מחדש ולעבור אימות שוב.',
            },
            {
              q: 'איפה המידע שלי מאוחסן?',
              a: 'מקומית על המכשיר שלך. מוצפן. רק אנשים שאימתת יכולים לפענח אותו.',
            },
            {
              q: 'יש שרת?',
              a: 'סנכרון בין מכשירים צריך תשתית. אבל היא מאחסנת רק נתונים מוצפנים - המפעיל לא יכול לקרוא כלום.',
            },
          ],
        },
        {
          category: 'התרחבות ומגבלות',
          questions: [
            {
              q: 'מה אם 10,000 אנשים ישתמשו בזה?',
              a: 'הרשת לא "מתרחבת" במובן המסורתי. אתה רואה רק תוכן מאנשים שאימתת. עם 10,000 משתמשים, יש הרבה רשתות קטנות שחופפות.',
            },
            {
              q: 'האם אני יכול לראות אנשים שהם "חברים של חברים"?',
              a: 'במקרה הבסיסי: לא. אתה רואה רק תוכן מאנשים שאתה בעצמך אימתת. הרחבות לשרשראות אמון אפשריות, אבל לא בשלב הראשון.',
            },
          ],
        },
      ],
    },

    // Footer
    footer: {
      cta: {
        title: 'מוכן לקשרים אמיתיים?',
        subtitle: 'אנחנו מחפשים קהילות לנסות, משוב על UX וקונספט, ומפתחים לבנות איתנו.',
        github: 'צפה ב-GitHub',
        spec: 'קרא מפרט',
      },
      projectTitle: 'פרויקט',
      contributeTitle: 'לתרום',
      links: {
        project: {
          concept: 'קונספט',
          prototype: 'פרוטוטייפ',
          specification: 'מפרט',
        },
        contribute: {
          issues: 'GitHub Issues',
          feedback: 'תן משוב',
          code: 'תרום קוד',
        },
      },
      description: 'רשת אמון מבוזרת לקהילות מקומיות. פרויקט מחקר ששם מפגשים אמיתיים מעל אלגוריתמים.',
      license: 'קוד פתוח תחת רישיון MIT',
      madeWith: {
        prefix: 'נעשה עם',
        suffix: 'לקהילות מקומיות',
      },
    },
  },

  it: {
    // Header
    nav: {
      concept: 'Concetto',
      howItWorks: 'Come funziona',
      apps: 'App',
      personas: 'Per chi?',
      faq: 'FAQ',
      blog: 'Blog',
    },

    // Hero
    hero: {
      badge: 'Progetto di ricerca Open Source',
      titleStart: 'Fiducia attraverso',
      titleHighlight: 'incontri reali',
      subtitle: 'Una rete di fiducia decentralizzata per comunità locali con strumenti per la collaborazione auto-organizzata dove i dati vengono condivisi solo crittografati con amici e gruppi.',
      cta: 'Scopri di più',
      demo: 'Prova la Demo',
      github: 'Vedi su GitHub',
      features: {
        verification: 'Verifica personale',
        encrypted: 'Crittografia end-to-end',
        offline: 'Funziona offline',
      },
    },

    // ProblemSolution
    problemSolution: {
      title: 'Un approccio diverso',
      subtitle: 'Ci concentriamo sulle comunità locali invece delle piattaforme globali. Invece di algoritmi, costruiamo su incontri reali.',
      today: 'Oggi',
      better: 'Meglio',
      problems: [
        { before: 'I social media catturano l\'attenzione', after: 'Connettersi nella vita reale' },
        { before: 'I tuoi dati sono con le corporazioni', after: 'I tuoi dati restano con te' },
        { before: 'Fiducia attraverso like e stelle', after: 'Fiducia attraverso incontri reali' },
        { before: 'Creazione account da soli davanti allo schermo', after: 'Onboarding attraverso amici in catena' },
        { before: 'Dipendente da server e connettività', after: 'Funziona senza internet' },
      ],
      pillarsTitle: 'I tre pilastri',
      pillars: [
        {
          title: 'Verificare',
          description: 'Confermare l\'identità attraverso un incontro personale',
          detail: 'Ogni relazione inizia con un incontro reale. Scansionando un codice QR confermi: "Questa è davvero questa persona."',
        },
        {
          title: 'Cooperare',
          description: 'Condividere contenuti crittografati',
          detail: 'Condividi calendari, posizioni e progetti con la tua rete. Tutto crittografato end-to-end.',
        },
        {
          title: 'Attestare',
          description: 'Costruire reputazione attraverso azioni reali',
          detail: 'Conferma ciò che altri hanno fatto. Queste attestazioni costruiscono fiducia visibile nel tempo.',
        },
      ],
      note: {
        title: 'Verificare ≠ Fidarsi',
        text: 'La verifica conferma solo: "Questa è davvero questa persona." La vera fiducia si sviluppa attraverso le attestazioni nel tempo.',
      },
    },

    // HowItWorks
    howItWorks: {
      title: 'Come funziona',
      subtitle: 'Dal primo incontro alla prima attestazione - il percorso nella rete.',
      step: 'Passo',
      steps: [
        {
          title: 'Scansiona il codice QR',
          description: 'Anna e Ben si incontrano. Ben scansiona il codice QR di Anna con l\'app.',
          detail: 'Il codice QR contiene la chiave pubblica di Anna. L\'app di Ben crea automaticamente la sua identità.',
        },
        {
          title: 'Conferma l\'identità',
          description: 'Ben conferma: "Ho incontrato Anna di persona."',
          detail: 'Questa verifica viene firmata crittograficamente e le chiavi vengono scambiate simultaneamente.',
        },
        {
          title: 'Vedi i contenuti',
          description: 'Ben ora può vedere i contenuti condivisi di Anna.',
          detail: 'Calendario, marcatori sulla mappa, progetti - tutto ciò che Anna condivide con i suoi contatti diventa decifrabile per Ben.',
        },
        {
          title: 'Crea un\'attestazione',
          description: 'Dopo aver lavorato insieme: Anna attesta l\'aiuto di Ben.',
          detail: '"Ben ha aiutato 3 ore in giardino" - questa dichiarazione firmata diventa parte del profilo di Ben.',
        },
      ],
      result: {
        title: 'Il risultato',
        text: 'Una rete crescente di relazioni reali. Ogni connessione è basata su un incontro personale. Ogni attestazione su un\'azione reale.',
      },
    },

    // Apps
    apps: {
      title: 'Cosa puoi fare con questo',
      subtitle: 'Web of Trust è il livello di fiducia. Varie app si costruiscono su di esso per abilitare la collaborazione locale.',
      items: [
        {
          title: 'Mappa',
          description: 'Trova persone, luoghi e offerte nelle vicinanze. Vedi chi può fare cosa e dove.',
        },
        {
          title: 'Calendario',
          description: 'Pianifica attività comuni, coordina date e invita a eventi.',
        },
        {
          title: 'Mercato',
          description: 'Condividi offerte e richieste. Scambia risorse con persone di cui ti fidi.',
        },
        {
          title: 'Apprezzamento',
          description: 'Ringrazia con voucher digitali. Regala tempo, aiuto o un grazie.',
        },
      ],
      note: {
        prefix: 'Tutte le app sono costruite su',
        suffix: '– un toolkit modulare open-source per reti locali.',
      },
    },

    // Personas
    personas: {
      title: 'Per chi è Web of Trust?',
      subtitle: 'Persone delle comunità locali che vogliono costruire connessioni reali.',
      needsLabel: 'Esigenze',
      howItHelpsLabel: 'Come aiuta Web of Trust',
      items: [
        {
          name: 'Hanna (62)',
          role: 'La Giardiniera',
          background: 'Attiva nell\'orto comunitario, non esperta di tecnologia, usa principalmente WhatsApp.',
          needs: [
            'Sapere chi annaffia quando',
            'Trovare nuovi aiutanti',
            'Non dover gestire la tecnologia',
          ],
          howItHelps: 'Il suo vicino Tom configura l\'app e la verifica. Lei vede il calendario dell\'orto e può toccare "Grazie" - questo diventa un\'attestazione.',
        },
        {
          name: 'Alexander (34)',
          role: 'Il Tuttofare',
          background: 'Può riparare qualsiasi cosa, conosce molte persone, organizza l\'aiuto di vicinato.',
          needs: [
            'Panoramica di chi può fare cosa',
            'Coordinare le richieste',
            'Niente caos dei gruppi WhatsApp',
          ],
          howItHelps: 'Verifica attivamente nuove persone agli incontri. Crea attestazioni: "Sa riparare biciclette", "Sa fare lavori elettrici". Vede sulla mappa chi offre cosa.',
        },
        {
          name: 'Lena (28)',
          role: 'La Scettica',
          background: 'Sviluppatrice software, attenta alla privacy, ha visto molti progetti "decentralizzati" fallire.',
          needs: [
            'Capire come funziona tecnicamente',
            'Essere sicura che i dati siano crittografati',
            'Nessun vendor lock-in',
          ],
          howItHelps: 'Open source - può controllare il codice. Crittografia E2E con chiavi locali. Tutti i dati esportabili.',
        },
        {
          name: 'Famiglia Kowalski',
          role: 'I Nuovi Arrivati',
          background: 'Nuovi in città, non conoscono nessuno, vogliono trovare connessione.',
          needs: [
            'Conoscere i vicini',
            'Trovare offerte affidabili',
            'Diventare parte di una comunità',
          ],
          howItHelps: 'Prime verifiche alla festa di strada. Vedono subito chi ha attestazioni. Possono raccogliere attestazioni loro stessi.',
        },
      ],
      note: 'La rete cresce solo attraverso incontri reali - ci vuole tempo, ma questo è il punto. Niente inviti di massa, niente account falsi.',
    },

    // Principles
    principles: {
      title: 'I Principi',
      subtitle: 'Cosa definisce Web of Trust - e cosa deliberatamente non è.',
      items: [
        {
          title: 'Dati con te',
          description: 'Tutti i tuoi dati sono crittografati sul tuo dispositivo. Solo le persone che hai verificato possono decifrarli.',
        },
        {
          title: 'Incontri reali',
          description: 'Ogni relazione nella rete è basata su un incontro personale. Questo previene account falsi e spam.',
        },
        {
          title: 'Funziona offline',
          description: 'Creare contenuti, verificare persone, dare attestazioni - tutto funziona senza internet. La sincronizzazione avviene dopo.',
        },
        {
          title: 'Open Source',
          description: 'Tutto il codice è pubblico. Puoi verificare come funziona e persino contribuire.',
        },
        {
          title: 'Tu hai la chiave',
          description: 'La tua identità crittografica appartiene a te. Con la frase di recupero puoi ripristinarla in qualsiasi momento.',
        },
        {
          title: 'Dati esportabili',
          description: 'Nessun vendor lock-in. Puoi esportare tutti i tuoi dati in qualsiasi momento.',
        },
      ],
      notTitle: {
        prefix: 'Cosa Web of Trust',
        highlight: 'non',
        suffix: 'è',
      },
      notFeatures: [
        'Non un social media per scrollare',
        'Niente pubblicità o tracciamento',
        'Niente algoritmi che decidono cosa vedi',
        'Niente blockchain o token crypto',
      ],
      note: 'Questo è un progetto di ricerca - impariamo e miglioriamo continuamente',
    },

    // FAQ
    faq: {
      title: 'Domande Frequenti',
      subtitle: 'Risposte alle domande più importanti su Web of Trust.',
      moreQuestions: 'Altre domande?',
      askOnGithub: 'Chiedi su GitHub',
      categories: [
        {
          category: 'Fondamenti',
          questions: [
            {
              q: 'Cosa lo rende diverso dai gruppi WhatsApp?',
              a: 'I tuoi dati restano con te, non con Meta. Tutto funziona offline. Le attestazioni costruiscono reputazione visibile. Niente caos di gruppo con 200 messaggi non letti.',
            },
            {
              q: 'Perché devo incontrare qualcuno di persona?',
              a: 'Questo è il nucleo del concetto. La verifica personale è il meccanismo di resistenza Sybil. Senza di essa, chiunque potrebbe creare 1000 account falsi.',
            },
            {
              q: 'Cosa vedo se non ho verificato nessuno?',
              a: 'Niente tranne il tuo profilo. La rete è grande solo quanto le tue relazioni reali.',
            },
            {
              q: 'Posso invitare persone senza incontrarle?',
              a: 'No. È intenzionale. Ogni relazione nella rete è basata su un incontro reale.',
            },
          ],
        },
        {
          category: 'Fiducia e Attestazioni',
          questions: [
            {
              q: 'Qual è la differenza tra verifica e attestazione?',
              a: 'Verifica: "Ho incontrato questa persona, è davvero lei." Attestazione: "Questa persona ha fatto X / sa fare Y." La verifica è l\'ancora dell\'identità. Le attestazioni sono la vera fiducia.',
            },
            {
              q: 'Posso ritirare un\'attestazione?',
              a: 'No. Le attestazioni sono dichiarazioni firmate su eventi passati. Se la relazione cambia, semplicemente non ne crei di nuove.',
            },
            {
              q: 'Cosa succede se qualcuno si comporta male?',
              a: 'Nascondi la persona. Mantiene le sue vecchie attestazioni (ha fatto le buone azioni), ma non vedi più i suoi contenuti. Altri possono fare lo stesso.',
            },
          ],
        },
        {
          category: 'Tecnico',
          questions: [
            {
              q: 'Cosa succede se perdo il telefono?',
              a: 'Se hai la frase di recupero: Tutto è recuperabile. Se no: La tua identità digitale è persa. Devi ricominciare e farti verificare di nuovo.',
            },
            {
              q: 'Dove sono memorizzati i miei dati?',
              a: 'Localmente sul tuo dispositivo. Crittografati. Solo le persone che hai verificato possono decifrarli.',
            },
            {
              q: 'C\'è un server?',
              a: 'La sincronizzazione tra dispositivi ha bisogno di infrastruttura. Ma memorizza solo blob crittografati - l\'operatore non può leggere nulla.',
            },
          ],
        },
        {
          category: 'Scalabilità e Limiti',
          questions: [
            {
              q: 'Cosa succede se 10.000 persone usano questo?',
              a: 'La rete non "scala" nel senso tradizionale. Vedi solo contenuti da persone che hai verificato. Con 10.000 utenti, ci sono molte piccole reti sovrapposte.',
            },
            {
              q: 'Posso vedere persone che sono "amici di amici"?',
              a: 'Nel caso base: No. Vedi solo contenuti da persone che hai verificato tu stesso. Estensioni per catene di fiducia sono concepibili, ma non nel primo passo.',
            },
          ],
        },
      ],
    },

    // Footer
    footer: {
      cta: {
        title: 'Pronto per connessioni reali?',
        subtitle: 'Cerchiamo comunità per provarlo, feedback su UX e concetto, e sviluppatori per costruire con noi.',
        github: 'Vedi su GitHub',
        spec: 'Leggi la specifica',
      },
      projectTitle: 'Progetto',
      contributeTitle: 'Contribuire',
      links: {
        project: {
          concept: 'Concetto',
          prototype: 'Prototipo',
          specification: 'Specifica',
        },
        contribute: {
          issues: 'GitHub Issues',
          feedback: 'Dai feedback',
          code: 'Contribuisci codice',
        },
      },
      description: 'Rete di fiducia decentralizzata per comunità locali. Un progetto di ricerca che mette gli incontri reali sopra gli algoritmi.',
      license: 'Open source sotto licenza MIT',
      madeWith: {
        prefix: 'Fatto con',
        suffix: 'per le comunità locali',
      },
    },
  },

  tr: {
    // Header
    nav: {
      concept: 'Konsept',
      howItWorks: 'Nasıl çalışır',
      apps: 'Uygulamalar',
      personas: 'Kimin için?',
      faq: 'SSS',
    },

    // Hero
    hero: {
      badge: 'Açık Kaynak Araştırma Projesi',
      titleStart: 'Güven',
      titleHighlight: 'gerçek karşılaşmalarla',
      subtitle: 'Yerel topluluklar için merkezi olmayan bir güven ağı; verilerin yalnızca arkadaşlar ve gruplarla şifreli olarak paylaşıldığı, kendi kendine organize işbirliği araçlarıyla.',
      cta: 'Daha fazla bilgi',
      demo: 'Demoyu Dene',
      github: 'GitHub\'da görüntüle',
      features: {
        verification: 'Kişisel doğrulama',
        encrypted: 'Uçtan uca şifreli',
        offline: 'Çevrimdışı çalışır',
      },
    },

    // ProblemSolution
    problemSolution: {
      title: 'Farklı bir yaklaşım',
      subtitle: 'Global platformlar yerine yerel topluluklara odaklanıyoruz. Algoritmalar yerine gerçek karşılaşmalar üzerine inşa ediyoruz.',
      today: 'Bugün',
      better: 'Daha iyi',
      problems: [
        { before: 'Sosyal medya dikkati ele geçiriyor', after: 'Gerçek hayatta bağlan' },
        { before: 'Verileriniz şirketlerde', after: 'Verileriniz sizinle kalır' },
        { before: 'Beğeniler ve yıldızlarla güven', after: 'Gerçek karşılaşmalarla güven' },
        { before: 'Ekran başında yalnız hesap oluşturma', after: 'Arkadaşlar zinciriyle katılım' },
        { before: 'Sunuculara ve bağlantıya bağımlı', after: 'İnternet olmadan çalışır' },
      ],
      pillarsTitle: 'Üç sütun',
      pillars: [
        {
          title: 'Doğrula',
          description: 'Kişisel karşılaşma ile kimliği onayla',
          detail: 'Her ilişki gerçek bir karşılaşmayla başlar. QR kod tarayarak onaylarsın: "Bu gerçekten bu kişi."',
        },
        {
          title: 'İşbirliği yap',
          description: 'Şifreli içerik paylaş',
          detail: 'Takvimler, konumlar ve projeleri ağınla paylaş. Her şey uçtan uca şifreli.',
        },
        {
          title: 'Tanıklık et',
          description: 'Gerçek eylemlerle itibar oluştur',
          detail: 'Başkalarının ne yaptığını onayla. Bu tanıklıklar zamanla görünür güven oluşturur.',
        },
      ],
      note: {
        title: 'Doğrulama ≠ Güven',
        text: 'Doğrulama sadece şunu onaylar: "Bu gerçekten bu kişi." Gerçek güven zamanla tanıklıklarla gelişir.',
      },
    },

    // HowItWorks
    howItWorks: {
      title: 'Nasıl çalışır',
      subtitle: 'İlk karşılaşmadan ilk tanıklığa - ağa giden yol.',
      step: 'Adım',
      steps: [
        {
          title: 'QR kodu tara',
          description: 'Anna ve Ben buluşur. Ben, uygulama ile Anna\'nın QR kodunu tarar.',
          detail: 'QR kod Anna\'nın açık anahtarını içerir. Ben\'in uygulaması otomatik olarak kendi kimliğini oluşturur.',
        },
        {
          title: 'Kimliği onayla',
          description: 'Ben onaylar: "Anna ile şahsen tanıştım."',
          detail: 'Bu doğrulama kriptografik olarak imzalanır ve anahtarlar eş zamanlı olarak değiştirilir.',
        },
        {
          title: 'İçeriği gör',
          description: 'Ben artık Anna\'nın paylaştığı içeriği görebilir.',
          detail: 'Takvim, harita işaretleri, projeler - Anna\'nın kişileriyle paylaştığı her şey Ben için çözülebilir hale gelir.',
        },
        {
          title: 'Tanıklık oluştur',
          description: 'Birlikte çalıştıktan sonra: Anna, Ben\'in yardımını tanıklar.',
          detail: '"Ben bahçede 3 saat yardım etti" - bu imzalı ifade Ben\'in profilinin bir parçası olur.',
        },
      ],
      result: {
        title: 'Sonuç',
        text: 'Gerçek ilişkilerden oluşan büyüyen bir ağ. Her bağlantı kişisel bir karşılaşmaya dayanır. Her tanıklık gerçek bir eyleme.',
      },
    },

    // Apps
    apps: {
      title: 'Bununla ne yapabilirsin',
      subtitle: 'Web of Trust güven katmanıdır. Çeşitli uygulamalar yerel işbirliğini sağlamak için bunun üzerine inşa edilir.',
      items: [
        {
          title: 'Harita',
          description: 'Yakındaki insanları, yerleri ve teklifleri bul. Kimin ne yapabileceğini ve nerede olduğunu gör.',
        },
        {
          title: 'Takvim',
          description: 'Ortak etkinlikler planla, tarihleri koordine et ve etkinliklere davet et.',
        },
        {
          title: 'Pazar yeri',
          description: 'Teklifleri ve istekleri paylaş. Güvendiğin insanlarla kaynak değiş tokuşu yap.',
        },
        {
          title: 'Takdir',
          description: 'Dijital kuponlarla teşekkür et. Zaman, yardım veya teşekkür hediye et.',
        },
      ],
      note: {
        prefix: 'Tüm uygulamalar',
        suffix: 'üzerine inşa edilmiştir – yerel ağlar için modüler açık kaynaklı araç seti.',
      },
    },

    // Personas
    personas: {
      title: 'Web of Trust kimin için?',
      subtitle: 'Gerçek bağlantılar kurmak isteyen yerel topluluklardan insanlar.',
      needsLabel: 'İhtiyaçlar',
      howItHelpsLabel: 'Web of Trust nasıl yardımcı olur',
      items: [
        {
          name: 'Hanna (62)',
          role: 'Bahçıvan',
          background: 'Topluluk bahçesinde aktif, teknoloji konusunda uzman değil, ağırlıklı olarak WhatsApp kullanıyor.',
          needs: [
            'Kimin ne zaman suladığını bilmek',
            'Yeni yardımcılar bulmak',
            'Teknolojiyle uğraşmamak',
          ],
          howItHelps: 'Komşusu Tom uygulamayı kurar ve onu doğrular. Bahçe takvimini görür ve "Teşekkürler"e dokunabilir - bu bir tanıklık olur.',
        },
        {
          name: 'Alexander (34)',
          role: 'Usta',
          background: 'Her şeyi tamir edebilir, birçok insan tanıyor, mahalle yardımı organize ediyor.',
          needs: [
            'Kimin ne yapabileceğine genel bakış',
            'Talepleri koordine etmek',
            'WhatsApp grup kaosu olmadan',
          ],
          howItHelps: 'Buluşmalarda yeni insanları aktif olarak doğrular. Tanıklıklar oluşturur: "Bisiklet tamir edebilir", "Elektrik işi yapabilir". Haritada kimin ne sunduğunu görür.',
        },
        {
          name: 'Lena (28)',
          role: 'Şüpheci',
          background: 'Yazılım geliştirici, gizlilik bilincinde, birçok "merkezi olmayan" projenin başarısız olduğunu gördü.',
          needs: [
            'Teknik olarak nasıl çalıştığını anlamak',
            'Verilerin şifrelendiğinden emin olmak',
            'Satıcı kilidi olmadan',
          ],
          howItHelps: 'Açık kaynak - kodu kontrol edebilir. Yerel anahtarlarla E2E şifreleme. Tüm veriler dışa aktarılabilir.',
        },
        {
          name: 'Kowalski Ailesi',
          role: 'Yeni gelenler',
          background: 'Şehirde yeni, kimseyi tanımıyorlar, bağlantı bulmak istiyorlar.',
          needs: [
            'Komşularla tanışmak',
            'Güvenilir teklifler bulmak',
            'Bir topluluğun parçası olmak',
          ],
          howItHelps: 'Sokak festivalinde ilk doğrulamalar. Kimin tanıklığı olduğunu hemen görürler. Kendileri de tanıklık toplayabilirler.',
        },
      ],
      note: 'Ağ sadece gerçek karşılaşmalarla büyür - bu zaman alır, ama mesele de bu. Toplu davetler yok, sahte hesaplar yok.',
    },

    // Principles
    principles: {
      title: 'İlkeler',
      subtitle: 'Web of Trust\'ı ne tanımlar - ve kasıtlı olarak ne değildir.',
      items: [
        {
          title: 'Veriler seninle',
          description: 'Tüm verilerin cihazında şifreli. Sadece doğruladığın kişiler şifresini çözebilir.',
        },
        {
          title: 'Gerçek karşılaşmalar',
          description: 'Ağdaki her ilişki kişisel bir karşılaşmaya dayanır. Bu sahte hesapları ve spam\'i önler.',
        },
        {
          title: 'Çevrimdışı çalışır',
          description: 'İçerik oluştur, insanları doğrula, tanıklık ver - her şey internet olmadan çalışır. Senkronizasyon sonra olur.',
        },
        {
          title: 'Açık Kaynak',
          description: 'Tüm kod halka açık. Nasıl çalıştığını kontrol edebilir ve hatta katkıda bulunabilirsin.',
        },
        {
          title: 'Anahtar sende',
          description: 'Kriptografik kimliğin sana ait. Kurtarma ifadesiyle istediğin zaman geri yükleyebilirsin.',
        },
        {
          title: 'Veriler dışa aktarılabilir',
          description: 'Satıcı kilidi yok. Tüm verilerini istediğin zaman dışa aktarabilirsin.',
        },
      ],
      notTitle: {
        prefix: 'Web of Trust ne',
        highlight: 'değildir',
        suffix: '',
      },
      notFeatures: [
        'Kaydırma için sosyal medya değil',
        'Reklam veya izleme yok',
        'Ne gördüğüne karar veren algoritma yok',
        'Blok zinciri veya kripto token yok',
      ],
      note: 'Bu bir araştırma projesi - sürekli öğreniyoruz ve gelişiyoruz',
    },

    // FAQ
    faq: {
      title: 'Sık Sorulan Sorular',
      subtitle: 'Web of Trust hakkında en önemli soruların cevapları.',
      moreQuestions: 'Daha fazla soru?',
      askOnGithub: 'GitHub\'da sor',
      categories: [
        {
          category: 'Temel Bilgiler',
          questions: [
            {
              q: 'Bu WhatsApp gruplarından ne farkı var?',
              a: 'Verilerin seninle kalır, Meta\'da değil. Her şey çevrimdışı çalışır. Tanıklıklar görünür itibar oluşturur. 200 okunmamış mesajlı grup kaosu yok.',
            },
            {
              q: 'Neden biriyle şahsen tanışmam gerekiyor?',
              a: 'Bu konseptin özü. Kişisel doğrulama Sybil direnci mekanizmasıdır. Onsuz herkes 1000 sahte hesap oluşturabilir.',
            },
            {
              q: 'Kimseyi doğrulamamışsam ne görürüm?',
              a: 'Kendi profilin dışında hiçbir şey. Ağ sadece gerçek ilişkilerin kadar büyük.',
            },
            {
              q: 'İnsanları tanışmadan davet edebilir miyim?',
              a: 'Hayır. Bu kasıtlı. Ağdaki her ilişki gerçek bir karşılaşmaya dayanır.',
            },
          ],
        },
        {
          category: 'Güven ve Tanıklıklar',
          questions: [
            {
              q: 'Doğrulama ve tanıklık arasındaki fark nedir?',
              a: 'Doğrulama: "Bu kişiyle tanıştım, gerçekten o." Tanıklık: "Bu kişi X yaptı / Y yapabilir." Doğrulama kimlik çapasıdır. Tanıklıklar gerçek güvendir.',
            },
            {
              q: 'Tanıklığı geri alabilir miyim?',
              a: 'Hayır. Tanıklıklar geçmiş olaylar hakkında imzalı ifadelerdir. İlişki değişirse, sadece yeni oluşturmazsın.',
            },
            {
              q: 'Biri kötü davranırsa ne olur?',
              a: 'Kişiyi gizlersin. Eski tanıklıklarını tutar (iyi işleri yaptı), ama artık içeriğini görmezsin. Başkaları da aynısını yapabilir.',
            },
          ],
        },
        {
          category: 'Teknik',
          questions: [
            {
              q: 'Telefonumu kaybedersem ne olur?',
              a: 'Kurtarma ifaden varsa: Her şey kurtarılabilir. Yoksa: Dijital kimliğin kayboldu. Baştan başlamalı ve tekrar doğrulanmalısın.',
            },
            {
              q: 'Verilerim nerede saklanıyor?',
              a: 'Cihazında yerel olarak. Şifreli. Sadece doğruladığın kişiler şifresini çözebilir.',
            },
            {
              q: 'Sunucu var mı?',
              a: 'Cihazlar arası senkronizasyon altyapıya ihtiyaç duyar. Ama sadece şifreli bloblar saklar - operatör hiçbir şey okuyamaz.',
            },
          ],
        },
        {
          category: 'Ölçekleme ve Sınırlar',
          questions: [
            {
              q: '10.000 kişi bunu kullanırsa ne olur?',
              a: 'Ağ geleneksel anlamda "ölçeklenmez". Sadece doğruladığın kişilerden içerik görürsün. 10.000 kullanıcıyla, birçok küçük örtüşen ağ var.',
            },
            {
              q: '"Arkadaşların arkadaşları" olan kişileri görebilir miyim?',
              a: 'Temel durumda: Hayır. Sadece kendin doğruladığın kişilerden içerik görürsün. Güven zincirleri için uzantılar düşünülebilir, ama ilk adımda değil.',
            },
          ],
        },
      ],
    },

    // Footer
    footer: {
      cta: {
        title: 'Gerçek bağlantılara hazır mısın?',
        subtitle: 'Denemek için topluluklar, UX ve konsept hakkında geri bildirim ve bizimle birlikte inşa edecek geliştiriciler arıyoruz.',
        github: 'GitHub\'da görüntüle',
        spec: 'Şartnameyi oku',
      },
      projectTitle: 'Proje',
      contributeTitle: 'Katkıda Bulun',
      links: {
        project: {
          concept: 'Konsept',
          prototype: 'Prototip',
          specification: 'Şartname',
        },
        contribute: {
          issues: 'GitHub Issues',
          feedback: 'Geri bildirim ver',
          code: 'Kod katkısı yap',
        },
      },
      description: 'Yerel topluluklar için merkezi olmayan güven ağı. Gerçek karşılaşmaları algoritmaların önüne koyan bir araştırma projesi.',
      license: 'MIT Lisansı altında açık kaynak',
      madeWith: {
        prefix: 'Yapıldı',
        suffix: 'yerel topluluklar için',
      },
    },
  },
}
