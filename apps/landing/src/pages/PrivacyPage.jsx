import Header from '../components/Header'
import Footer from '../components/Footer'
import { useLanguage } from '../i18n/LanguageContext'

export default function PrivacyPage() {
  const { language } = useLanguage()

  return (
    <div className="min-h-screen">
      <Header />
      <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        {language === 'de' ? <PrivacyDE /> : <PrivacyEN />}
      </main>
      <Footer />
    </div>
  )
}

function PrivacyDE() {
  return (
    <article className="prose prose-stone dark:prose-invert max-w-none">
      <h1>Datenschutzerklärung</h1>
      <p className="text-muted-foreground">Stand: April 2026</p>

      <h2>Verantwortlicher</h2>
      <p>
        Anton Tranelis<br />
        E-Mail: anton@utopia-lab.org
      </p>

      <h2>Grundprinzip</h2>
      <p>
        Web of Trust ist eine dezentrale App für selbstbestimmte digitale Identität.
        <strong> Deine Daten gehören dir.</strong> Es gibt keinen zentralen Server der
        deine persönlichen Daten speichert. Deine kryptographischen Schlüssel verlassen
        niemals dein Gerät.
      </p>

      <h2>Welche Daten werden verarbeitet?</h2>

      <h3>Lokal auf deinem Gerät (niemals übertragen)</h3>
      <ul>
        <li>Kryptographische Schlüssel (Ed25519, X25519) — im Android Keystore bzw. iOS Keychain</li>
        <li>BIP39 Seed (verschlüsselt mit AES-256-GCM)</li>
        <li>Kontakte, Bestätigungen, Space-Daten (verschlüsselt in IndexedDB)</li>
        <li>Biometrische Merkmale — werden ausschließlich vom Betriebssystem verarbeitet, die App erhält nur eine Ja/Nein-Antwort</li>
      </ul>

      <h3>Übertragen (Ende-zu-Ende verschlüsselt)</h3>
      <ul>
        <li><strong>Relay-Server</strong> (wss://relay.utopia-lab.org) — leitet verschlüsselte Nachrichten zwischen Geräten weiter. Der Server kann den Inhalt nicht lesen.</li>
        <li><strong>Vault-Server</strong> — speichert verschlüsselte Backups. Der Server kann den Inhalt nicht lesen.</li>
      </ul>

      <h3>Öffentlich (bewusst vom Nutzer veröffentlicht)</h3>
      <ul>
        <li><strong>Profil-Server</strong> (profiles.utopia-lab.org) — Name, Bio und Avatar, sofern du sie veröffentlichst. Du entscheidest was öffentlich ist.</li>
        <li><strong>DID (Decentralized Identifier)</strong> — deine öffentliche Adresse im Netzwerk.</li>
      </ul>

      <h2>Berechtigungen</h2>

      <h3>Kamera</h3>
      <p>
        Wird ausschließlich zum Scannen von QR-Codes bei der persönlichen Verifizierung verwendet.
        Es werden keine Bilder gespeichert oder übertragen.
      </p>

      <h3>Biometrie (Fingerabdruck / Gesichtserkennung)</h3>
      <p>
        Optional zum Entsperren der App. Die biometrischen Daten werden vom Betriebssystem verarbeitet
        (Android Keystore / iOS Secure Enclave). Die App erhält keinen Zugriff auf biometrische Rohdaten.
      </p>

      <h3>Internet</h3>
      <p>
        Für die Synchronisation zwischen Geräten und den Empfang von Nachrichten.
        Alle übertragenen Daten sind Ende-zu-Ende verschlüsselt.
      </p>

      <h2>Tracking & Analytics</h2>
      <p>
        <strong>Es gibt kein Tracking.</strong> Keine Analytics, keine Cookies, keine Werbe-IDs,
        kein Google Analytics, kein Firebase. Die App enthält keine Drittanbieter-SDKs
        die Nutzerdaten sammeln.
      </p>

      <h2>Datenweitergabe</h2>
      <p>
        Deine Daten werden nicht an Dritte weitergegeben. Es gibt keinen Datenhandel,
        keine Werbung, keine Kooperationen mit Datenhändlern.
      </p>

      <h2>Datenlöschung</h2>
      <p>
        Du kannst jederzeit alle lokalen Daten löschen (Identität → Ausloggen).
        Öffentliche Profildaten können über die App zurückgezogen werden.
        Verschlüsselte Backups auf dem Vault-Server können per API gelöscht werden.
      </p>

      <h2>Open Source</h2>
      <p>
        Der gesamte Quellcode ist öffentlich einsehbar unter{' '}
        <a href="https://github.com/real-life-org/web-of-trust" target="_blank" rel="noopener noreferrer">
          github.com/real-life-org/web-of-trust
        </a>{' '}
        (MIT-Lizenz). Jede Aussage in dieser Datenschutzerklärung kann im Code überprüft werden.
      </p>

      <h2>Kontakt</h2>
      <p>
        Bei Fragen zum Datenschutz: anton@utopia-lab.org
      </p>
    </article>
  )
}

function PrivacyEN() {
  return (
    <article className="prose prose-stone dark:prose-invert max-w-none">
      <h1>Privacy Policy</h1>
      <p className="text-muted-foreground">Last updated: April 2026</p>

      <h2>Responsible Party</h2>
      <p>
        Anton Tranelis<br />
        Email: anton@utopia-lab.org
      </p>

      <h2>Core Principle</h2>
      <p>
        Web of Trust is a decentralized app for self-sovereign digital identity.
        <strong> Your data belongs to you.</strong> There is no central server storing
        your personal data. Your cryptographic keys never leave your device.
      </p>

      <h2>What Data Is Processed?</h2>

      <h3>Locally on Your Device (never transmitted)</h3>
      <ul>
        <li>Cryptographic keys (Ed25519, X25519) — stored in Android Keystore or iOS Keychain</li>
        <li>BIP39 seed (encrypted with AES-256-GCM)</li>
        <li>Contacts, attestations, space data (encrypted in IndexedDB)</li>
        <li>Biometric data — processed exclusively by the operating system; the app only receives a yes/no response</li>
      </ul>

      <h3>Transmitted (end-to-end encrypted)</h3>
      <ul>
        <li><strong>Relay server</strong> (wss://relay.utopia-lab.org) — forwards encrypted messages between devices. The server cannot read the content.</li>
        <li><strong>Vault server</strong> — stores encrypted backups. The server cannot read the content.</li>
      </ul>

      <h3>Public (consciously published by the user)</h3>
      <ul>
        <li><strong>Profile server</strong> (profiles.utopia-lab.org) — name, bio, and avatar, if you choose to publish them. You decide what is public.</li>
        <li><strong>DID (Decentralized Identifier)</strong> — your public address in the network.</li>
      </ul>

      <h2>Permissions</h2>

      <h3>Camera</h3>
      <p>
        Used exclusively for scanning QR codes during in-person verification.
        No images are stored or transmitted.
      </p>

      <h3>Biometrics (Fingerprint / Face Recognition)</h3>
      <p>
        Optionally used to unlock the app. Biometric data is processed by the operating system
        (Android Keystore / iOS Secure Enclave). The app has no access to raw biometric data.
      </p>

      <h3>Internet</h3>
      <p>
        For synchronization between devices and receiving messages.
        All transmitted data is end-to-end encrypted.
      </p>

      <h2>Tracking & Analytics</h2>
      <p>
        <strong>There is no tracking.</strong> No analytics, no cookies, no advertising IDs,
        no Google Analytics, no Firebase. The app contains no third-party SDKs
        that collect user data.
      </p>

      <h2>Data Sharing</h2>
      <p>
        Your data is not shared with third parties. There is no data trading,
        no advertising, no partnerships with data brokers.
      </p>

      <h2>Data Deletion</h2>
      <p>
        You can delete all local data at any time (Identity → Log out).
        Public profile data can be withdrawn through the app.
        Encrypted backups on the vault server can be deleted via API.
      </p>

      <h2>Open Source</h2>
      <p>
        The entire source code is publicly available at{' '}
        <a href="https://github.com/real-life-org/web-of-trust" target="_blank" rel="noopener noreferrer">
          github.com/real-life-org/web-of-trust
        </a>{' '}
        (MIT license). Every claim in this privacy policy can be verified in the code.
      </p>

      <h2>Contact</h2>
      <p>
        For privacy-related questions: anton@utopia-lab.org
      </p>
    </article>
  )
}
