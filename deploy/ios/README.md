# iOS release: from a tag to TestFlight

The iOS counterpart of the Android path in `build-on-tag.yml`. A tag `app-v3.x.y` builds the v3 app
(`apps/wot-v3`) on a macOS runner, signs it with the distribution certificate of the repository's
secrets, uploads it to App Store Connect and adds it to the external TestFlight group. Nobody signs or
uploads by hand. Without the secrets the same run ends with an unsigned archive as the artifact.

| | |
|---|---|
| Trigger | tag `app-v3.*` (or `workflow_dispatch` with the tag), job `ios` in `.github/workflows/build-on-tag.yml`; Gen-2 tags (`app-v0/1/2.*`) have no iOS build |
| Runner | `macos-15` (GitHub-hosted), `timeout-minutes: 60`. Capacitor 8 needs Xcode 26; the image selects an older Xcode by default, so `build-ios.sh` picks the newest `/Applications/Xcode_26*.app` for its run (`DEVELOPER_DIR`) and aborts without one |
| Build | `apps/wot-v3/scripts/build-ios.sh <tag>`: `pnpm build:appstore` (no live update, `VITE_MEDIATOR_DID` required), `cap sync ios`, store-build check on the synced assets, plugin completeness of `CapApp-SPM/Package.swift`, `xcodebuild archive`, `-exportArchive` (method `app-store-connect`), native artifact check on the IPA |
| Version | from the tag like Android: `MARKETING_VERSION` 3.x.y, `CURRENT_PROJECT_VERSION` (build number) major·10000 + minor·100 + patch (`scripts/version-from-tag.sh`; 3.0.2 → 30002). Every tag has a new build number, so App Store Connect never sees a duplicate |
| Signing | in CI, manual signing: certificate "Apple Distribution" + App Store provisioning profile from the secrets below, in a temporary keychain that the script deletes at the end |
| Upload | `apps/wot-v3/scripts/upload-testflight.sh <tag>`: fastlane `pilot upload` with an App Store Connect API key; with `IOS_TESTFLIGHT_GROUP` set the build goes into that external group (Beta App Review for the first build of a version), testers are notified |
| Artifact | `ios-<tag>` (30 days): `App-3.x.y.ipa` or `App-unsigned.xcarchive.zip`, `build-info.json` (tag, commit, version, build number, mediator, OTA disabled, signed, signing team/profile), `SHA256SUMS`. On failure `ios-logs-<tag>` with the xcodebuild logs |
| Updates | none over the air (`VITE_TARGET=appstore`, no live-update plugin; checked in the bundle, the synced assets and the executable). Testers get the next tag through TestFlight |
| App | bundle id `org.reallife.weboftrust` (the Android application id and the Gen-2 id), Universal Links `applinks:web-of-trust.de` for card links `/c`, `/c/*`, privacy manifest `PrivacyInfo.xcprivacy` (file timestamps C617.1 for `@capacitor/filesystem`, UserDefaults CA92.1 for the bridge; checked in the IPA) |

## Why signing in CI and not in the signing service

Android signs outside the repository in `wot-release` (Linux server, key custody: the upload key is not
rotatable without Google). iOS does not fit that path:

- Signing and exporting an IPA needs Xcode (`codesign`, `xcodebuild -exportArchive`); the signing
  service runs on Linux without a Mac. The macOS runner that builds is the only place that can sign.
- Apple's key material is revocable and short-lived: the distribution certificate expires after one
  year and can be revoked and replaced in the developer account at any time; the App Store Connect API
  key can be revoked at any time. Nothing of it is a one-way key like the Android upload key.
- The secrets stay encrypted in GitHub, are readable only by workflow runs on this repository (not by
  pull requests from forks), and are used only on tag pushes, which only maintainers can do.

So the public repository holds, encrypted: one distribution certificate with its private key, one
provisioning profile and one API key with the role App Manager. What it never holds: the Apple ID,
its password, or the account's team agent role.

Not chosen, but possible later: Xcode cloud signing (`-allowProvisioningUpdates` with the API key), which
would remove the certificate and profile from the secrets. Unverified here; it changes nothing for
Tillmann's steps except that steps 3 and 4 fall away.

## Secrets and variables

Repository settings → Secrets and variables → Actions. Names as the workflow reads them; the test
`apps/wot-v3/tests/ios-shell.test.ts` checks that every name the workflow uses stands in this table.

| Name | Kind | Content | From step |
|---|---|---|---|
| `VITE_MEDIATOR_DID` | variable | the mediator DID of the store builds (exists, shared with Android) | — |
| `IOS_TEAM_ID` | variable | the 10-character Team ID of Tillmann's developer account | 1 |
| `IOS_DIST_CERT_P12_BASE64` | secret | the "Apple Distribution" certificate with its private key, PKCS#12, base64 in one line | 3 |
| `IOS_DIST_CERT_PASSWORD` | secret | the password of that .p12 | 3 |
| `IOS_PROVISIONING_PROFILE_BASE64` | secret | the App Store provisioning profile (`.mobileprovision`) for `org.reallife.weboftrust`, base64 | 4 |
| `ASC_KEY_ID` | secret | Key ID of the App Store Connect API key | 6 |
| `ASC_ISSUER_ID` | secret | Issuer ID of the team's API keys | 6 |
| `ASC_API_KEY_P8_BASE64` | secret | the `.p8` file of the key, base64 | 6 |
| `IOS_TESTFLIGHT_GROUP` | variable | name of the external TestFlight group; empty = upload only, no distribution | 7 |

base64 in one line on a Mac: `base64 -i file | tr -d '\n' | pbcopy`. The script refuses a partial set of
the four signing values and builds unsigned when all four are absent.

## What Tillmann does once

Everything below happens in Tillmann's Apple Developer account (the account that pays the membership;
decision of 18 October 2026). After it, no release needs him. Click paths as of October 2026; Apple
moves menus, the names stay.

1. **Team ID.** developer.apple.com → Account → Membership details → *Team ID* (10 characters). Give it
   to Anton: repository variable `IOS_TEAM_ID` and the placeholder `TEAMID` in
   `apps/landing/public/.well-known/apple-app-site-association`.
2. **App ID.** developer.apple.com → Certificates, Identifiers & Profiles → Identifiers → **+** → App IDs →
   App → Description `Web of Trust`, Bundle ID *explicit* `org.reallife.weboftrust` → Capabilities:
   tick **Associated Domains** → Register. If the account already has an App ID with this bundle id
   (the Gen-2 app, `apps/demo/ios`, never reached the App Store from this account as far as the
   repository knows), add the capability to it instead.
3. **Distribution certificate.** On a Mac: Keychain Access → Certificate Assistant → Request a
   Certificate From a Certificate Authority → your e-mail, *Saved to disk* → `.certSigningRequest`.
   developer.apple.com → Certificates → **+** → **Apple Distribution** → upload the request → Download
   `.cer` → double-click (lands in the login keychain next to its private key). Keychain Access → My
   Certificates → right-click the certificate *Apple Distribution: <name>* → Export → format **.p12**,
   choose a password. Then `base64 -i distribution.p12 | tr -d '\n'` → secret `IOS_DIST_CERT_P12_BASE64`,
   the password → `IOS_DIST_CERT_PASSWORD`. The certificate is valid for one year; renewal is the same
   step and a new provisioning profile (step 4). Delete the `.p12` from disk after it is stored as a
   secret; the private key stays in the keychain.
4. **Provisioning profile.** developer.apple.com → Profiles → **+** → Distribution → **App Store
   Connect** → App ID from step 2 → certificate from step 3 → name `Web of Trust App Store` → Generate →
   Download `.mobileprovision` → `base64 -i … | tr -d '\n'` → secret `IOS_PROVISIONING_PROFILE_BASE64`.
   The build checks that the profile is for `<Team ID>.org.reallife.weboftrust` and carries Associated
   Domains. A profile expires with its certificate.
5. **App record.** appstoreconnect.apple.com → Apps → **+** → New App → Platforms *iOS*, Name `Web of
   Trust`, Primary Language *English (U.S.)* or *German*, Bundle ID from step 2, SKU
   `org.reallife.weboftrust`, User Access *Full Access* → Create. The upload needs this record; fastlane
   adds builds to an app, it does not create one.
6. **API key.** App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys →
   **+** → Name `web-of-trust CI`, Access **App Manager** → Generate → Download the `.p8` (offered once).
   Key ID stands in the row, Issuer ID above the table. Secrets `ASC_KEY_ID`, `ASC_ISSUER_ID`,
   `ASC_API_KEY_P8_BASE64` (`base64 -i AuthKey_XXXX.p8 | tr -d '\n'`). App Manager is the lowest role that
   uploads builds and manages TestFlight groups. The key does not expire; it can be revoked in the same
   place.
7. **TestFlight group with a public link.** App Store Connect → the app → TestFlight → *External
   Testing* → **+** → group name (for example `Public`) → in the group: **Enable Public Link** → copy
   the link (`https://testflight.apple.com/join/…`), set a tester limit if wanted (10 000 at most).
   Variable `IOS_TESTFLIGHT_GROUP` = the group name. Also under TestFlight → *Test Information*: Beta
   App Review contact (name, e-mail, phone), Beta App Description, privacy policy URL
   `https://web-of-trust.de/privacy`. Apple needs these before the first external build is reviewed.
8. **Anton's access.** App Store Connect → Users and Access → **+** → Anton's Apple ID, role *App
   Manager*, apps: Web of Trust. Then Anton answers export compliance, reads Beta App Review results
   and later submits the App Store review without Tillmann. Without this step, those clicks are
   Tillmann's.
9. **Hand over the secrets.** Either way works:
   - Tillmann enters them himself: GitHub → `real-life-org/web-of-trust` → Settings → Secrets and
     variables → Actions → New repository secret / New variable. He is an admin of the repository, so
     no rights change; the key material never leaves his machine except into GitHub's encrypted store.
   - Or Tillmann sends the values to Anton over an end-to-end encrypted channel (never e-mail or a
     chat in plain text) and Anton enters them; afterwards both delete the message.

Yearly: steps 3 and 4 (new certificate, new profile, two secrets replaced). Nothing else recurs.

## What happens per release

Nothing by hand. Anton pushes a tag (below); then:

1. `build-on-tag.yml` starts the jobs `build` (Android, unchanged) and `ios`.
2. `build-ios.sh` checks that HEAD carries the tag, derives version and build number, selects Xcode 26
   or newer, builds the web bundle for `appstore`, runs `cap sync ios`, checks the synced assets and that every plugin of
   `capacitor.config.ts` is in the Swift package, imports certificate and profile into a temporary
   keychain, archives, exports the IPA and checks the IPA for the live-update plugin.
3. The artifact `ios-<tag>` is uploaded (IPA, `build-info.json`, `SHA256SUMS`).
4. `upload-testflight.sh` uploads the IPA with the API key and adds it to the external group. For the
   first build of a new version string Apple runs Beta App Review (experience: about a day, often
   less); later builds of the same version usually reach testers after processing (minutes). Testers
   with the public link or in the group get a notification.
5. The temporary keychain and the profile are removed from the runner.

Without the signing secrets steps 2 to 3 run with an unsigned archive and step 4 is skipped; the run is
green, the artifact says `signed: false`. That is how the path is tested before step 3 above.

## What Anton does

- **Tag.** As for Android: `git tag app-v3.x.y <commit>` on main, `git push origin app-v3.x.y` (both
  jobs run from one tag; release-please dispatches the same workflow).
- **Once, after the first upload:** App Store Connect → the app → TestFlight → the build. Export
  compliance: the build asks "Does your app use encryption?" until it is answered or Info.plist carries
  `ITSAppUsesNonExemptEncryption`. The answer is a product decision (the app uses standard end-to-end
  encryption, not only the system's), see the checklist in `rltp`. After the decision the key goes
  into `apps/wot-v3/ios/App/App/Info.plist`, and no later build asks.
- **First external build:** Beta App Review is submitted when the build enters the group. If Apple
  asks for anything (test notes, a second device for the encounter), it appears in App Store Connect →
  TestFlight → the build. Anton answers there with the App Manager role from Tillmann's step 8.
- **Later:** App Store review and the store listing are not part of this path; the checklist in
  `rltp/design/store-launch-v3/app-store-checkliste-v3-2026-10-31.md` lists what App Store Connect
  wants (privacy labels, age rating, screenshots, export compliance, user-generated content, account
  deletion).

## Universal Links

`apps/wot-v3/ios/App/App/App.entitlements` claims `applinks:web-of-trust.de`;
`apps/landing/public/.well-known/apple-app-site-association` names `TEAMID.org.reallife.weboftrust` for
`/c` and `/c/*`. Replace `TEAMID` with the Team ID from step 1 (one commit on the landing, deployed
with the next merge to main). iOS fetches the file through Apple's CDN; after the deploy check
`https://app-site-association.cdn-apple.com/a/v1/web-of-trust.de` returns the file. The landing is
served by GitHub Pages, which sends extensionless files as `application/octet-stream`; Apple documents
`application/json`. Whether Apple's CDN accepts the file as served is unverified until the first check
of that URL; if it refuses, the file needs a host that sets the content type.

## Unverified until the first run

There is no Mac in the environment that built this path. What only Xcode can check:

- The Swift of the own plugins (`BiometricKeystorePlugin.swift`, `ScreenProtectionPlugin.swift`,
  `AppSettingsPlugin.swift`, `MyViewController.swift`) compiles; the first `ios` job on a tag is the
  compiler run. Their interfaces against the TypeScript side are checked in `ios-shell.test.ts`.
- `xcodebuild` resolves the Swift packages (network to GitHub for `capacitor-swift-pm`), the manual
  signing settings and the export options.
- The fastlane `pilot` options as written in `upload-testflight.sh`.

`@real-life-org/capacitor-zxing-scanner` is on 1.1.3: `Package.swift` at the package root and the product
named as the Capacitor CLI derives it from the npm name (`RealLifeOrgCapacitorZxingScanner`). Both are
what `cap sync ios` and SwiftPM need; `build-ios.sh` step 4 and `ios-shell.test.ts` check every plugin
for them, so a plugin that regresses fails before the Mac.

## On a Mac

```bash
cd apps/wot-v3
VITE_MEDIATOR_DID=did:… pnpm build:appstore
VITE_TARGET=appstore pnpm exec cap sync ios
VITE_TARGET=appstore pnpm exec cap open ios      # Xcode: set your team under Signing & Capabilities, run on a device
```

A release build from a tag, unsigned: `VITE_MEDIATOR_DID=did:… apps/wot-v3/scripts/build-ios.sh app-v3.x.y`
on a checkout that carries the tag; with the four signing values in the environment it exports the IPA.
