# Releasing

Wie aus einem Merge auf `main` veröffentlichte Artefakte werden — für **beide**
Ausgänge dieses Repos: die **npm-Pakete** (für externe Entwickler) und die
**App** (Web of Trust Demo, für Nutzer auf F-Droid / Play / Obtainium).

Ein einziger Motor treibt beides: **release-please**. Er sammelt Conventional
Commits, hält *eine* Release-PR offen und erzeugt beim Merge die passenden Tags.

---

## Das Gesamtbild

```
Merge auf main
  → release-please pflegt EINE Release-PR (Pakete + App, nach Conventional Commits)
  → du mergst sie:
       ├─ Paket-Tags  core-v* / adapter-yjs-v* / …  → publish.yml (Dispatch) → npm
       └─ App-Tag     app-vX.Y.Z                     → build-on-tag (Dispatch) → CI
                                                        baut APK (F-Droid) + AAB (Play)
                                                        → Server signiert & liefert aus
```

Zwei Ausgänge aus einer PR, npm und App. Die App baut die Workspace-Pakete **aus
dem Quellcode** (`pnpm --filter … build`), nicht aus npm — sie wartet nie auf den
npm-Publish.

**Wichtig — Paket-Änderungen lösen einen App-Release aus.** Die App hängt via
`workspace:*` an `wot-core` und den Adaptern; ein `fix:`/`feat:` nur unter
`packages/**` würde für sich genommen nur das Paket bumpen. Damit die Änderung
auch **Play** erreicht (Play hat kein OTA, updated nur über ein getaggtes AAB),
kaskadiert das release-please-Plugin **`node-workspace`** den Bump auf jeden
Dependent — also auf die App. Ergebnis: ein Paket-Fix, der in die App kompiliert,
erzeugt zuverlässig auch einen `app-v*`-Tag → nativen Build → Play-Auslieferung.
(F-Droid bekäme dieselbe Änderung ohnehin per OTA; Play nur über diesen Weg.)

> **Der Vertrag dahinter ist zerbrechlich** — `node-workspace` nimmt nur
> Komponenten mit aufgelöstem `release-type: node` in den Graphen; eine als
> `simple` konfigurierte App fällt still heraus, und ein root-relativer
> `extra-files`-Pfad bumpt die Versionsdatei nie. Beides ist sonst unsichtbar und
> kracht erst beim Release. Deshalb prüft
> **`scripts/release/test-release-cascade.mjs`** diese Invarianten bei jedem PR
> (Job `release-cascade` in `ci.yml`): Plugin aktiv, App und alle konsumierten
> Pakete sind `node`-Komponenten, `extra-files` zeigt auf die echte Datei,
> Versionen in Manifest / `package.json` / `version.properties` stimmen überein.
> Lokal: `node scripts/release/test-release-cascade.mjs`.

---

## Was wodurch ausgelöst wird

| Ereignis | Läuft |
|---|---|
| **Merge auf `main`** (App-/Paket-Pfade) | `deploy.yml` → Web-App + **OTA-Update**; `release-please.yml` → Release-PR; CI/Conformance |
| **Merge der Release-PR** | Tags entstehen → `publish.yml` (npm) + `build-on-tag` (App) per Dispatch |
| **`app-v*`-Tag** | `build-on-tag` → APK + AAB als CI-Artefakt; ab `app-v3.*` zusätzlich Job `ios` → signierte IPA → TestFlight (`deploy/ios/README.md`) |
| **Release published** | `publish.yml` hängt tgz-Assets an (npm-Pakete) |

> **GITHUB_TOKEN-Tags triggern keine Workflows** (GitHub-Rekursionsschutz).
> Deshalb stößt `release-please.yml` `publish.yml` **und** `build-on-tag`
> ausdrücklich per `workflow_dispatch` an, statt sich auf `on: push tags` /
> `on: release` zu verlassen.

---

## Die npm-Pakete

Konfiguriert in `release-please-config.json` (sechs Pakete: `wot-core`,
`adapter-yjs`, `adapter-automerge`, `wot-relay`, `wot-vault`, `wot-profiles`).

1. Conventional Commits unter `packages/<x>/**` bumpen das jeweilige Paket.
2. Merge der Release-PR → Tag `<component>-vX.Y.Z` (z. B. `core-v0.5.2`).
3. `release-please.yml` (Job `trigger-publish`) dispatcht `publish.yml` pro
   released Paket.
4. `publish.yml` published nach npm via **Trusted Publishing (OIDC)** — kein
   Token im Repo. Der Anspruch nennt `publish.yml`, worauf npmjs.com konfiguriert
   ist (deshalb Dispatch als Top-Level-Workflow, nicht `workflow_call`).

---

## Die App

### Version & versionCode

`apps/demo/android/version.properties` führt **nur** den Semver-Namen:

```properties
# x-release-please-version
VERSION_NAME=0.2.7
```

Der Android-`versionCode` wird **deterministisch abgeleitet** — an zwei Stellen
mit derselben Formel (`build.gradle` für den Build, `build-android.sh` für die
`build-info`):

```
versionCode = major * 10000 + minor * 100 + patch
0.2.7 → 207   0.2.8 → 208   0.3.0 → 300   1.0.0 → 10000
```

Monoton, solange minor/patch < 100. So muss release-please nur den **Namen**
führen — den kann es (Semver), einen Integer nicht.

> **Einmaliger Sprung:** Bestehende Releases hatten Codes 1…9. Ab dem nächsten
> Release gilt die Formel (0.2.8 → 208). Der Sprung 9 → 208 ist unkritisch —
> Stores verlangen nur *steigende* Codes, Lücken sind erlaubt.

### Zwei Kanäle, zwei Web-Builds

`build-on-tag` baut **zwei** Bundles, weil sich F-Droid und Play im Web-Layer
unterscheiden **müssen** (siehe `scripts/release/build-android.sh`):

| Artefakt | Web-Build | OTA | signiert mit |
|---|---|---|---|
| **APK** (F-Droid + Obtainium) | `VITE_UPDATE_CHANNEL=android-foss` | **an** | F-Droid-Key |
| **AAB** (Play) | `VITE_DISABLE_LIVE_UPDATE=true` | **aus** | Play-Upload-Key |

Ein **OTA-Sentinel** im Build erzwingt die Trennung (`android-foss` muss im
F-Droid-Bundle stehen, darf nicht im Play-Bundle). Google verbietet Self-Updates
außerhalb seines Mechanismus — das Play-AAB darf den OTA-Updater nicht tragen.

### Konsequenz der OTA-Trennung

- **F-Droid-Nutzer** bekommen Web-Änderungen bei **jedem Merge** automatisch per
  OTA (`deploy.yml`, Kanal `android-foss`). Ein neuer nativer Build ist nur nötig,
  wenn sich die App-Hülle ändert (Capacitor-Plugins, native Rechte).
- **Play-Nutzer** bekommen **kein** OTA. Sie updaten **nur** über einen neuen
  AAB-Upload — also über ein getaggtes Release. Web-Änderungen erreichen sie erst
  beim nächsten `app-v`-Tag.

### Signieren & Ausliefern (Server, `wot-release`)

`build-on-tag` produziert **unsignierte** Artefakte. Signiert wird auf dem Server,
wo die Schlüssel liegen (nicht rotierbar, dürfen die Maschine nicht verlassen):

```bash
# auf dem Server, nach grünem build-on-tag-Lauf:
cd ~/wot-release
docker compose run --rm signer       wot app-vX.Y.Z   # F-Droid + GitHub-Release (Obtainium)
docker compose run --rm play-publish wot app-vX.Y.Z   # Play internal
```

Beide prüfen die **Provenienz** vor dem Signieren (kanonischer build-on-tag-Lauf,
Tag-Commit, exakter Hash gegen `SHA256SUMS`, OTA-Zustand). Details im
`wot-release`-README.

> Volle Automatik (kein Handgriff) käme mit dem `wot-release`-**v2-Runner**:
> `build-on-tag` feuert bei Erfolg ein `repository_dispatch` ans private
> wot-release-Repo, ein self-hosted Runner signiert. Bewusst noch nicht aktiv
> (self-hosted Runner nur am privaten Repo — Fork-PR-RCE-Risiko).

---

## Ein Release schneiden

1. **Arbeiten wie immer** mit Conventional Commits (`feat:`, `fix:`, `feat!:`).
   Der Pfad bestimmt die Komponente: `apps/demo/**` → App, `packages/wot-core/**`
   → core, usw.
2. release-please hält automatisch eine **Release-PR** offen (Titel „chore:
   release …"). Sie zeigt die geplanten Versionen + Changelogs.
3. **Release-PR mergen.** Damit entstehen die Tags, npm wird publiziert, und
   `build-on-tag` baut das App-Artefakt.
4. **CI abwarten** (`build-on-tag` grün, Artefakt `android-app-vX.Y.Z` vorhanden).
5. **Auf dem Server signieren & ausliefern** (siehe oben). Danach:
   - F-Droid: `fdroid.utopia-lab.org` zeigt die neue Version.
   - Play: internal testing (Promotion zu production ist ein bewusster
     Console-Schritt).
   - Obtainium: signierte APK am GitHub-Release `app-vX.Y.Z`.

---

## Rollback

- **OTA (Web-Layer, F-Droid):** `deploy.yml` per `workflow_dispatch` mit
  `rollback_tag: ota-<sha>` — stellt ein früheres Bundle wieder her.
- **Native App:** kein Downgrade möglich (versionCode nur steigend). Fix
  vorwärts: Patch-Release schneiden.
- **npm:** `npm deprecate` / neue Patch-Version. Kein Unpublish.

---

## Warum es so gebaut ist (Kurzfassung)

- **Plattform ist Trigger, nicht Gehirn:** die Build-Logik lebt in
  `scripts/release/build-android.sh`, die YAML ist nur Hülle. Ein Umzug zu
  Forgejo/GitLab tauscht die Hülle.
- **Schlüssel-Verwahrung:** nicht rotierbare Signierschlüssel liegen nur auf dem
  Server; CI baut reproduzierbar und unsigniert.
- **Ein Release-Zug:** Pakete und App teilen sich release-please, laufen aber
  über getrennte Tags/Trigger — keine Kopplung, kein Konflikt.
