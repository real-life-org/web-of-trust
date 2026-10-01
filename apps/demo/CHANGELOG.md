# Changelog

## [0.4.0](https://github.com/real-life-org/web-of-trust/compare/app-v0.3.8...app-v0.4.0) (2026-10-01)


### ⚠ BREAKING CHANGES

* **core:** MessageEnvelope, MessageType, signEnvelope, verifyEnvelope und der Einstieg @web_of_trust/core/crypto entfallen; WireMessage ist nur noch die DIDComm-Familie.

### Features

* Profiländerungen verschlüsselt per inbox/1.0 an die Kontakte (wot[#386](https://github.com/real-life-org/web-of-trust/issues/386)) ([4f3638e](https://github.com/real-life-org/web-of-trust/commit/4f3638e97ccdbc5f0497bb84cc1ce7b804730bb7))


### Bug Fixes

* **demo:** eine serialisierte Schreibstelle fuer Kontaktprofile (Review [#390](https://github.com/real-life-org/web-of-trust/issues/390) Runde 2) ([34e4497](https://github.com/real-life-org/web-of-trust/commit/34e44977cd4a47af6d8fd45955ada3f1e3aa444b))
* **profile-update:** Review [#390](https://github.com/real-life-org/web-of-trust/issues/390) — Serialisierung, kein Ack ohne Anwendung, offers/needs, RFC 3339 ([b2ce1ef](https://github.com/real-life-org/web-of-trust/commit/b2ce1ef3453496415cedcb4b12634faf43f016d6))


### Code Refactoring

* **core:** Old-World-Typen und den crypto-Einstieg entfernen (wot[#386](https://github.com/real-life-org/web-of-trust/issues/386)) ([5eadc58](https://github.com/real-life-org/web-of-trust/commit/5eadc582cb0fe809ce293087d02176fd920ae808))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @web_of_trust/adapter-automerge bumped to 0.3.0
    * @web_of_trust/adapter-yjs bumped to 0.3.0
    * @web_of_trust/core bumped to 0.6.0

## [0.3.8](https://github.com/real-life-org/web-of-trust/compare/app-v0.3.7...app-v0.3.8) (2026-09-24)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @web_of_trust/adapter-automerge bumped to 0.2.10
    * @web_of_trust/adapter-yjs bumped to 0.2.10
    * @web_of_trust/core bumped to 0.5.10

## [0.3.7](https://github.com/real-life-org/web-of-trust/compare/app-v0.3.6...app-v0.3.7) (2026-09-15)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @web_of_trust/adapter-automerge bumped to 0.2.9
    * @web_of_trust/adapter-yjs bumped to 0.2.9
    * @web_of_trust/core bumped to 0.5.9

## [0.3.6](https://github.com/real-life-org/web-of-trust/compare/app-v0.3.5...app-v0.3.6) (2026-09-11)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @web_of_trust/adapter-automerge bumped to 0.2.8
    * @web_of_trust/adapter-yjs bumped to 0.2.8
    * @web_of_trust/core bumped to 0.5.8

## [0.3.5](https://github.com/real-life-org/web-of-trust/compare/app-v0.3.4...app-v0.3.5) (2026-09-11)


### Bug Fixes

* **messaging:** Connect-Timeout mit echtem Abbruch im WebSocketMessagingAdapter ([#355](https://github.com/real-life-org/web-of-trust/issues/355)) ([45004a1](https://github.com/real-life-org/web-of-trust/commit/45004a1d193f1840ba10f7975098d82e1d25fdf2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @web_of_trust/adapter-automerge bumped to 0.2.7
    * @web_of_trust/adapter-yjs bumped to 0.2.7
    * @web_of_trust/core bumped to 0.5.7

## [0.3.4](https://github.com/real-life-org/web-of-trust/compare/app-v0.3.3...app-v0.3.4) (2026-08-17)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @web_of_trust/adapter-automerge bumped to 0.2.6
    * @web_of_trust/adapter-yjs bumped to 0.2.6
    * @web_of_trust/core bumped to 0.5.6

## [0.3.3](https://github.com/real-life-org/web-of-trust/compare/app-v0.3.2...app-v0.3.3) (2026-08-05)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @web_of_trust/adapter-automerge bumped to 0.2.5
    * @web_of_trust/adapter-yjs bumped to 0.2.5
    * @web_of_trust/core bumped to 0.5.5

## [0.3.2](https://github.com/real-life-org/web-of-trust/compare/app-v0.3.1...app-v0.3.2) (2026-08-05)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @web_of_trust/adapter-automerge bumped to 0.2.4
    * @web_of_trust/adapter-yjs bumped to 0.2.4
    * @web_of_trust/core bumped to 0.5.4

## [0.3.1](https://github.com/real-life-org/web-of-trust/compare/app-v0.3.0...app-v0.3.1) (2026-08-04)


### Bug Fixes

* **inbox:** konkreten Prüf-Fehler bei invalid-inner-jws-Reject durchreichen ([35ef0fb](https://github.com/real-life-org/web-of-trust/commit/35ef0fbb0ad077dfce4d5349d9954c045e2bf61c))
* **inbox:** konkreten Prüf-Fehler bei invalid-inner-jws-Reject durchreichen ([2f819c6](https://github.com/real-life-org/web-of-trust/commit/2f819c67033dba2c64b5d86c19d3c4c5abaf27ca))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @web_of_trust/adapter-automerge bumped to 0.2.3
    * @web_of_trust/adapter-yjs bumped to 0.2.3
    * @web_of_trust/core bumped to 0.5.3

## [0.3.0](https://github.com/real-life-org/web-of-trust/compare/app-v0.2.7...app-v0.3.0) (2026-08-03)


### ⚠ BREAKING CHANGES

* **ci:** WoT flavorlos — build-on-tag baut APK (F-Droid) + AAB (Play)

### Features

* App-Releases über release-please (unified train) + volle Doku ([2ea1656](https://github.com/real-life-org/web-of-trust/commit/2ea1656030d559e96ea84731e2c1873c6370fe48))
* App-Releases über release-please (unified train) + volle Doku ([1286106](https://github.com/real-life-org/web-of-trust/commit/1286106bbf4603ccbf1b696ce9eea99c120695e1))
* **ci:** WoT flavorlos — build-on-tag baut APK (F-Droid) + AAB (Play) ([c744053](https://github.com/real-life-org/web-of-trust/commit/c7440534eaec8d5039bb46f935cf76772010a297))
* **identity:** Magic Words nummeriert kopieren ([#278](https://github.com/real-life-org/web-of-trust/issues/278)) ([0b66b39](https://github.com/real-life-org/web-of-trust/commit/0b66b398b74a20300bd087eac446dd9134097e4b))


### Bug Fixes

* App als release-type node — node-workspace-Kaskade greift jetzt wirklich ([5df6ee7](https://github.com/real-life-org/web-of-trust/commit/5df6ee70916b552b9d20808578714d5038333f87))
* **ci:** Demo-Vite-Aliase auch fuer tiefe core-Subpfade — dist-Flake-Quelle beseitigt ([#294](https://github.com/real-life-org/web-of-trust/issues/294)) ([fd87ea2](https://github.com/real-life-org/web-of-trust/commit/fd87ea22ab664ef760fbfc190c49ead086cc78d0))
* **ci:** getrennte Web-Builds für F-Droid (OTA) und Play (kein OTA) ([74deb0c](https://github.com/real-life-org/web-of-trust/commit/74deb0cf36c775aa0356137693b2b9ba2fcb39a5))
* Review-Blocker — extra-files-Pfad, node-workspace-Kaskade, strikter versionCode ([551a5d5](https://github.com/real-life-org/web-of-trust/commit/551a5d5b24d45ec0f4f0f5812abed8fd205b82a0))
