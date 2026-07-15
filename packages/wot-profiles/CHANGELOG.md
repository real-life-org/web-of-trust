# Changelog

## [0.2.0](https://github.com/real-life-org/web-of-trust/compare/profiles-v0.1.2...profiles-v0.2.0) (2026-07-15)


### ⚠ BREAKING CHANGES

* **wot-core:** delete ProfileService + ./services subpath (breaking removal)

### Features

* **1b3:** discovery-recovery + discovery-attestations — /a+/v Compact-JWS ListResource, Rollback, Server-Monotonie, Recovery-Workflow ([c9fa7d3](https://github.com/real-life-org/web-of-trust/commit/c9fa7d34ba6a375c288f16d439e0ae7642d482b8))
* **1b3:** OfflineFirst verifications-dirty + wot-profiles server-monotonicity (Step 4) ([72d1f3c](https://github.com/real-life-org/web-of-trust/commit/72d1f3cf86ddc612348cdfc5ea059cb7ff632969))


### Bug Fixes

* **1b3:** address CodeRabbit + Copilot review (defensive copies, overflow guards, test hardening) ([edd7955](https://github.com/real-life-org/web-of-trust/commit/edd795581a6aef1a66fd8e81cf3a71851fdb6e31))
* **1b3:** wot-profiles enforces mandatory integer version + always-on monotonicity (review MAJOR 1) ([7ae10c7](https://github.com/real-life-org/web-of-trust/commit/7ae10c74d6d3e0fc2a6db7bbcb10d9f0d0c9aea4))
* **discovery,protocol:** address [#186](https://github.com/real-life-org/web-of-trust/issues/186) re-review bot findings ([af8e818](https://github.com/real-life-org/web-of-trust/commit/af8e818a90454abd6094bff414278363b461e440))
* **docker:** relay+profiles bauen [@web](https://github.com/web)_of_trust/core aus dem Workspace ([76adf02](https://github.com/real-life-org/web-of-trust/commit/76adf0252078e8fcdacb92136e02c99751d05ac1))


### Code Refactoring

* **wot-core:** delete ProfileService + ./services subpath (breaking removal) ([f88d913](https://github.com/real-life-org/web-of-trust/commit/f88d913607e14a0561f605ce31c349d1aea87730))

## [0.1.2](https://github.com/antontranelis/web-of-trust/compare/profiles-v0.1.1...profiles-v0.1.2) (2026-03-29)


### Features

* debug dashboard + relay challenge-response auth ([4894aa3](https://github.com/antontranelis/web-of-trust/commit/4894aa3efd0fca9c8e55a28a9fe735ff4de5e0d7))
* DiscoveryAdapter — 7th adapter for public profile discovery ([10db340](https://github.com/antontranelis/web-of-trust/commit/10db3402d39cf52f26b0f7bcdf035df58b0a7264))
* Profile Sync (Phase 1) + Symmetric Crypto (Phase 2) + Evolu cross-device sync ([75fd173](https://github.com/antontranelis/web-of-trust/commit/75fd17336cbf4837f199fea3fb9aa1dbf568d148))
* rename packages from [@web](https://github.com/web).of.trust/* to [@web](https://github.com/web)_of_trust/* ([85a0730](https://github.com/antontranelis/web-of-trust/commit/85a0730a553ba89761f779c894fd870f347d7dbc))
* rename packages from @real-life/* to [@web](https://github.com/web).of.trust/* ([9ddb159](https://github.com/antontranelis/web-of-trust/commit/9ddb159170d743fd0ae3f70993c981118fd8e4f2))

## [0.1.1](https://github.com/antontranelis/web-of-trust/compare/@web_of_trust/profiles-v0.1.0...@web_of_trust/profiles-v0.1.1) (2026-03-26)


### Features

* debug dashboard + relay challenge-response auth ([4894aa3](https://github.com/antontranelis/web-of-trust/commit/4894aa3efd0fca9c8e55a28a9fe735ff4de5e0d7))
* DiscoveryAdapter — 7th adapter for public profile discovery ([10db340](https://github.com/antontranelis/web-of-trust/commit/10db3402d39cf52f26b0f7bcdf035df58b0a7264))
* Profile Sync (Phase 1) + Symmetric Crypto (Phase 2) + Evolu cross-device sync ([75fd173](https://github.com/antontranelis/web-of-trust/commit/75fd17336cbf4837f199fea3fb9aa1dbf568d148))
* rename packages from @real-life/* to [@web](https://github.com/web).of.trust/* ([9ddb159](https://github.com/antontranelis/web-of-trust/commit/9ddb159170d743fd0ae3f70993c981118fd8e4f2))
