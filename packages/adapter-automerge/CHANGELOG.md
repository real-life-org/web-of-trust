# Changelog

## [0.1.5](https://github.com/real-life-org/web-of-trust/compare/adapter-automerge-v0.1.4...adapter-automerge-v0.1.5) (2026-07-22)


### Bug Fixes

* **automerge:** defer keyless ghost capability work ([49b6ea5](https://github.com/real-life-org/web-of-trust/commit/49b6ea5a1f14d0929d5150e0b2c3ef9d1a3f51ce))
* chain capability catch-up after coalescing ([14e93cb](https://github.com/real-life-org/web-of-trust/commit/14e93cb262ff8f68ab144b7a9bc063d1073d3831))
* defer reseed capability generation ([a9db57d](https://github.com/real-life-org/web-of-trust/commit/a9db57d2a53fb02efbc25f6a432d0314ed825269))
* retry capability catchup after reseed ([0ef7f73](https://github.com/real-life-org/web-of-trust/commit/0ef7f7310602ec2710d17e17ddbc1b1358338a04))
* **sync:** Reseed — Capability-Praesentation deferrt bei fehlenden Keys statt zu crashen ([21a8223](https://github.com/real-life-org/web-of-trust/commit/21a8223d42eae3baf92c3390434069cbfd6cc07f))

## [0.1.4](https://github.com/real-life-org/web-of-trust/compare/adapter-automerge-v0.1.3...adapter-automerge-v0.1.4) (2026-07-20)


### Features

* **sync:** P0b — MembershipActivityCapable + membershipRemovals (Membership-Schnitt) ([c161b7c](https://github.com/real-life-org/web-of-trust/commit/c161b7cd7e6882f35d72b9cbda4b3794c76f4647))


### Bug Fixes

* converge secure removal recovery ([0d13b4d](https://github.com/real-life-org/web-of-trust/commit/0d13b4d9df626962b6d6d0561de30191cfbb1673))
* gate secure self-leave by durable capabilities ([f5a67c8](https://github.com/real-life-org/web-of-trust/commit/f5a67c8f16aa10979e888158edef881716cf6793))
* **sync:** Automerge catchUpGeneration an echten Coordinator statt Stub — Fremd-Removal konvergiert nach GENERATION_GAP ([49996d2](https://github.com/real-life-org/web-of-trust/commit/49996d277a5ab2f800fbf598c504c9f7649df08d))

## [0.1.3](https://github.com/real-life-org/web-of-trust/compare/adapter-automerge-v0.1.2...adapter-automerge-v0.1.3) (2026-07-15)


### Features

* **1.B.3-key-rotation:** produktive Capability-JWS-Schicht + ECIES-Wire-Migration ([477a083](https://github.com/real-life-org/web-of-trust/commit/477a0835a48d067d45ca5d967c151f4897492ead))
* **1b3:** Automerge-Mirror — Members-Set, Resolution/Cleanup, future-rotation durabel (Step 5) ([ce74e3d](https://github.com/real-life-org/web-of-trust/commit/ce74e3d899ca1778fea1be78d3aea01e983d00e6))
* **adapters:** I-READ "Key-available ⇒ replayBlockedByKey" on all key-available paths (Yjs + Automerge) ([3bae587](https://github.com/real-life-org/web-of-trust/commit/3bae587e1810bd649d793d348df9975e13fc687f))
* **adapters:** productive key-rotation + invite wire migration (ECIES container) ([1e262a1](https://github.com/real-life-org/web-of-trust/commit/1e262a196d864576337b77f33afb915adf13a13d))
* **automerge+core:** convert Automerge adapter onto the shared log path + VE-9 UUID-docId (Slice A Phase 4) ([ae6803b](https://github.com/real-life-org/web-of-trust/commit/ae6803bd8c7e8746251a2efc3be2aadd294f8e91))
* **core,adapters,demo:** Durable Wiring — completion gate (headline e2e + reload-decrypt + onSecurityError) ([4e5774d](https://github.com/real-life-org/web-of-trust/commit/4e5774df38a07c90fe10f6f0f208a3bc164c76b4))
* **core,adapters:** catch-up completeness — pagination loop + seq-gap handling (Slice B) ([d022e57](https://github.com/real-life-org/web-of-trust/commit/d022e57537f8c1d455253357604da3a33800cdaa))
* **core,adapters:** Durable Wiring Phase 1 — N2 partial-store guards + E1 propagation + sendControlFrame passthrough ([da4e2b4](https://github.com/real-life-org/web-of-trust/commit/da4e2b42d90841c2808ae2b05dd60cb50af47aa6))
* **core,adapters:** Durable Wiring Phase 2b — VE-11 restore-clone rebind + Trigger-1/2 split ([7c5e719](https://github.com/real-life-org/web-of-trust/commit/7c5e719a75bea7f7f7fc1f05cc0e1d2d63e9ac6e))
* **core,adapters:** two-phase broker-enforced secure removal (Slice SR VE-C1/VE-C3) ([6a2c4cd](https://github.com/real-life-org/web-of-trust/commit/6a2c4cdf02275a1831529bfbf45e02aa0294a4c8))
* **core,relay,adapters:** KEY_GENERATION_STALE re-emit for the legitimate lagger (Slice SR VE-C2) ([2e9c150](https://github.com/real-life-org/web-of-trust/commit/2e9c15041109f52d232dbc71d9f09223dabe9099))
* **core:** I-CAP — content-bound capability import on the duplicate key-rotation path (multi-device write after rotation) ([2d570e6](https://github.com/real-life-org/web-of-trust/commit/2d570e6c1b700c646e840f220467fea5458180ba))
* **demo,adapters:** generischer Dialog-Lifecycle multi-device (synced dismissedNotifications) ([a1ef3d8](https://github.com/real-life-org/web-of-trust/commit/a1ef3d87b2da52ee24ffde8e89c3de0ae072b2cd))
* **demo:** A2 Teil A — wire PersonalLogSyncAdapter onto the durable-log path [WIP: E2E hardening pending] ([e7aef1d](https://github.com/real-life-org/web-of-trust/commit/e7aef1db6eb9cc78ed79f46510b32bfac6686274))
* **group-key-workflow:** mint capability key pair + self-capability ([3d4f9b8](https://github.com/real-life-org/web-of-trust/commit/3d4f9b88dbfdf45d86007b63e36047e4476577a4))
* **inbox-wire:** Automerge-Mirror der DIDComm-Migration (Step 6) ([aa4814a](https://github.com/real-life-org/web-of-trust/commit/aa4814a518f25f67960baf729bcfddd571011d7c))
* **spaces:** echte Admin-Liste im synced Doc — 1.B.3-admin-management ([5ade33c](https://github.com/real-life-org/web-of-trust/commit/5ade33c77fc5c7a549d4237c99d542e92b00042a))
* **spaces:** echte Admin-Liste im synced Doc — 1.B.3-admin-management ([bff37c2](https://github.com/real-life-org/web-of-trust/commit/bff37c2ce2659472a68fefdba3b34de3dee715cc))


### Bug Fixes

* **1b3:** address PR [#178](https://github.com/real-life-org/web-of-trust/issues/178) review findings (DI wiring + polish) ([ea7600e](https://github.com/real-life-org/web-of-trust/commit/ea7600e862538fe66e19f5a83f571098f2de4b48))
* **1b3:** AM content-pending-buffer blocked-by-key + atomares Key/Gen-Lesen (Sync 002 Z.173, B1/F4) ([396bee3](https://github.com/real-life-org/web-of-trust/commit/396bee3997d056b78928c57d0927306aa89695c5))
* **1b3:** AM event-set auf reservierten root-key (Kollisionsschutz, F-6) ([fcd8abb](https://github.com/real-life-org/web-of-trust/commit/fcd8abbf804ba58eefa561aa38509ca3d3d74e12))
* **1b3:** AM members-container-seed im invite-apply (Review-Minor) ([ce42849](https://github.com/real-life-org/web-of-trust/commit/ce42849959128527b806b29dbb880dca8541e181))
* **1b3:** AM resolution-chain + enc-key-pruning (M1-Spiegel, MINOR-1) ([227947b](https://github.com/real-life-org/web-of-trust/commit/227947b309775b3ba2b48c8e7209b61dca22de31))
* **1b3:** deterministischer members-container-seed auch in createSpace (M2) ([1ffb67d](https://github.com/real-life-org/web-of-trust/commit/1ffb67d51b3b18ab7eff5d6c0c4a4714f2ce3918))
* **1b3:** publish empty /v and /a on offline-retry; untrack tsbuildinfo (Codex review [#198](https://github.com/real-life-org/web-of-trust/issues/198)) ([6f33008](https://github.com/real-life-org/web-of-trust/commit/6f3300886bdf9f7225e928810f3278f2b6e29655))
* **1b3:** re-derive isVerification from stored vcJws on storage read (review BLOCKER) ([6f3420f](https://github.com/real-life-org/web-of-trust/commit/6f3420ff44004ca8c1a57f6825c83ef5cafb8e84))
* **1b3:** resolution auch nach savePending + restore (Sync 005 Z.194, Review-M1) ([ccd8354](https://github.com/real-life-org/web-of-trust/commit/ccd83549a2562005295490ef2aafd737008082cc))
* **1b3:** review-nacharbeiten (Befund-Pin-Header, Drop-Logzeile, members[0]-Kommentare, Test-Flake-Härtung) ([54142e4](https://github.com/real-life-org/web-of-trust/commit/54142e48502ad24bfa0ce1f1027d2609c0409449))
* **adapter-automerge:** PersonalDocManager importiert Core via /storage statt Root (CI [#201](https://github.com/real-life-org/web-of-trust/issues/201)) ([f975bad](https://github.com/real-life-org/web-of-trust/commit/f975badfa44b02f8916bf17d0d5056f611e0da05))
* **adapters:** close B3 retry/idempotency hole — never treat local presence as durable proof (loop-review re-review) ([14babe0](https://github.com/real-life-org/web-of-trust/commit/14babe0c075257c810e58fc3cf70f80b906a92e5))
* **adapters:** drop the coordinator + replay-guard state on cleanupSpaceLocally (stale-coordinator, Yjs↔Automerge parity) ([a81c95c](https://github.com/real-life-org/web-of-trust/commit/a81c95cf06b5cf6360a87ce897e1761f36da824c))
* **adapters:** guard member-removal under enableLogSync as unsupported; remove half-built VE-10 broker-enforcement (Slice A) ([45771f1](https://github.com/real-life-org/web-of-trust/commit/45771f1928d851b005436480d858fba96df8f674))
* **core,adapters,test:** address loop-review (codex-gpt-5 + CodeRabbit) on PR [#214](https://github.com/real-life-org/web-of-trust/issues/214) ([50b4fd5](https://github.com/real-life-org/web-of-trust/commit/50b4fd5d341614d97767aa616ee66b5aed4380e7))
* **core,relay,adapters:** close 3 safety blockers + broker-url check from loop-review (Slice SR-3) ([0f25188](https://github.com/real-life-org/web-of-trust/commit/0f2518863f21dbbf924cb42aec497feabee80df7))
* **core,relay,adapters:** close the 3 CodeRabbit Non-Security findings + minors (Slice SR-4) ([91bce7f](https://github.com/real-life-org/web-of-trust/commit/91bce7f1391990b68cd32a247cc7e948bf7d4223))
* **core,relay:** converge the legitimate lagger over real WS + route all write-path rejects (Slice SR-2, [#213](https://github.com/real-life-org/web-of-trust/issues/213)) ([4101225](https://github.com/real-life-org/web-of-trust/commit/41012259a8d73e373e969d1501d27d9385fb844d))
* **core+adapters:** close AES-GCM nonce-reuse blocker + churn/liveness concerns from dual review (Slice A) ([f71d2bd](https://github.com/real-life-org/web-of-trust/commit/f71d2bd306a04d27cd09a54902d5f0ab28877696))
* **core+adapters:** enforce member-removal at the broker via durable retriable space-rotate (Slice A VE-10 blocker) ([3cf4ee9](https://github.com/real-life-org/web-of-trust/commit/3cf4ee920df721b044ec612bd005cc7e126f5b1c))
* **inbox-wire:** automerge documentUrl in den authentifizierten Pfad (Review M2) ([e55ee3b](https://github.com/real-life-org/web-of-trust/commit/e55ee3b8b83842790281cdd984f9985ab7f5650f))
* **inbox-wire:** message-id-history erst bei konklusiver Verarbeitung (Sync 003 Z.466) ([e92ecb4](https://github.com/real-life-org/web-of-trust/commit/e92ecb4b5d399d029406dadde8ec9cce2a72022a))
* **inbox-wire:** review-nacharbeiten (stale kommentare, VE-6-doku, space-invite-klassifikation, outbox-typen) ([d99d794](https://github.com/real-life-org/web-of-trust/commit/d99d7940770e57d1c0f5a7442b0658de5b0413f9))
* **key-rotation:** address [#189](https://github.com/real-life-org/web-of-trust/issues/189) re-review (2 should-fix) ([c8b1ea4](https://github.com/real-life-org/web-of-trust/commit/c8b1ea4941858660cfe6ce878189cafcfa5ade55))
* **key-rotation:** address [#189](https://github.com/real-life-org/web-of-trust/issues/189) review round 1 ([6f6a1ac](https://github.com/real-life-org/web-of-trust/commit/6f6a1ac02a59a9d444d8d7ac1aef48971233c1de))
* **member-update:** address [#188](https://github.com/real-life-org/web-of-trust/issues/188) re-review findings (store + adapters) ([aca1bca](https://github.com/real-life-org/web-of-trust/commit/aca1bca5d7c5938969cddedcb97b60e198cb01e4))
* preserve cached graph during publish state cleanup ([04e9b2b](https://github.com/real-life-org/web-of-trust/commit/04e9b2ba2cc8e067e31e0d7f67c584c01238376a))
* **sync:** address PR-review blockers ([#234](https://github.com/real-life-org/web-of-trust/issues/234)) ([59c2ee1](https://github.com/real-life-org/web-of-trust/commit/59c2ee1da3094abceef9fe7724ab15ea18bd864d))
* **sync:** guard generation&gt;=0 in _persistSpaceMetadata seed lookup ([#234](https://github.com/real-life-org/web-of-trust/issues/234) PR-review) ([fbad51c](https://github.com/real-life-org/web-of-trust/commit/fbad51c923c9de61256767d3b29e67b017763b02))
* **sync:** persist+restore capability signing seed so a recovered device can write ([#234](https://github.com/real-life-org/web-of-trust/issues/234)) ([239bbd0](https://github.com/real-life-org/web-of-trust/commit/239bbd0a2b39fbf645c4cc50c59738f4b54c8d84))
* **sync:** recovered device can write to existing spaces — persist+restore capability signing seed ([#234](https://github.com/real-life-org/web-of-trust/issues/234)) ([2abc70c](https://github.com/real-life-org/web-of-trust/commit/2abc70c40451fc5ea160d0267aaa6069af903e46))
* **vault:** bound every VaultClient fetch with an AbortController timeout ([46b2f4e](https://github.com/real-life-org/web-of-trust/commit/46b2f4e9c45032e319aef06dfd79d1c0af3d3e5c))
* **vault:** VaultClient-fetch-Timeout — kappt den 5G-Startup-Hang (ohne Init-Umbau) ([29ca509](https://github.com/real-life-org/web-of-trust/commit/29ca5095b682c45a2ee4e34bbf9e58d0d00bfdb5))

## [0.1.2](https://github.com/antontranelis/web-of-trust/compare/adapter-automerge-v0.1.1...adapter-automerge-v0.1.2) (2026-03-29)


### Features

* add "Leave Space" button to Space detail page ([c8770c0](https://github.com/antontranelis/web-of-trust/commit/c8770c01b85e14fbfcd26a95351e86a2eedf4b24))
* allow all members to invite, only creator can remove ([5394d5a](https://github.com/antontranelis/web-of-trust/commit/5394d5a307cf0185c470c6f8c5ed9c24b6a4308b))
* rename packages from [@web](https://github.com/web).of.trust/* to [@web](https://github.com/web)_of_trust/* ([85a0730](https://github.com/antontranelis/web-of-trust/commit/85a0730a553ba89761f779c894fd870f347d7dbc))
* rename packages from @real-life/* to [@web](https://github.com/web).of.trust/* ([9ddb159](https://github.com/antontranelis/web-of-trust/commit/9ddb159170d743fd0ae3f70993c981118fd8e4f2))
* space metadata in shared Y.Doc (_meta map) + space management UI ([0c231b8](https://github.com/antontranelis/web-of-trust/commit/0c231b84a9d95e133dff716b950784df2da61041))
* wire AuthorizationAdapter into AutomergeReplicationAdapter ([d6b5dfe](https://github.com/antontranelis/web-of-trust/commit/d6b5dfeabd9c99c86c67ba0bd98ba00dbb385958))


### Bug Fixes

* **ci:** update wot-core-dist for Docker build + fix flaky test timeout ([0fbd7cc](https://github.com/antontranelis/web-of-trust/commit/0fbd7cc7e69d4bf38214aa33bdfb9cc442fc0279))

## [0.1.1](https://github.com/antontranelis/web-of-trust/compare/@web_of_trust/adapter-automerge-v0.1.0...@web_of_trust/adapter-automerge-v0.1.1) (2026-03-26)


### Features

* add "Leave Space" button to Space detail page ([c8770c0](https://github.com/antontranelis/web-of-trust/commit/c8770c01b85e14fbfcd26a95351e86a2eedf4b24))
* allow all members to invite, only creator can remove ([5394d5a](https://github.com/antontranelis/web-of-trust/commit/5394d5a307cf0185c470c6f8c5ed9c24b6a4308b))
* rename packages from @real-life/* to [@web](https://github.com/web).of.trust/* ([9ddb159](https://github.com/antontranelis/web-of-trust/commit/9ddb159170d743fd0ae3f70993c981118fd8e4f2))
* space metadata in shared Y.Doc (_meta map) + space management UI ([0c231b8](https://github.com/antontranelis/web-of-trust/commit/0c231b84a9d95e133dff716b950784df2da61041))
* wire AuthorizationAdapter into AutomergeReplicationAdapter ([d6b5dfe](https://github.com/antontranelis/web-of-trust/commit/d6b5dfeabd9c99c86c67ba0bd98ba00dbb385958))
