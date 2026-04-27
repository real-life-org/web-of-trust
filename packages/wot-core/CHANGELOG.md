# Changelog

## [0.2.3](https://github.com/real-life-org/web-of-trust/compare/core-v0.2.2...core-v0.2.3) (2026-04-27)


### Features

* add spec sync encryption vectors ([24e6260](https://github.com/real-life-org/web-of-trust/commit/24e6260aab99f3e23f35184ed2a7461a00f1b9c4))
* add spec sync JWS vectors ([2ce93e2](https://github.com/real-life-org/web-of-trust/commit/2ce93e2a0dadb2ef7552653a441b6544afe371d7))
* add spec-core interop layer ([c0ed43a](https://github.com/real-life-org/web-of-trust/commit/c0ed43a3cd0d9fb410247fcb6594515b267595f0))
* cover DID resolution vector ([b970f51](https://github.com/real-life-org/web-of-trust/commit/b970f51963002a34ad8065a04da8b1619ebc2369))
* cover remaining phase-1 spec vectors ([7bf5412](https://github.com/real-life-org/web-of-trust/commit/7bf54125815d76ec6d81be90fd45bb00fd7e4357))

## [0.2.2](https://github.com/antontranelis/web-of-trust/compare/core-v0.2.1...core-v0.2.2) (2026-03-29)


### Features

* add "Leave Space" button to Space detail page ([c8770c0](https://github.com/antontranelis/web-of-trust/commit/c8770c01b85e14fbfcd26a95351e86a2eedf4b24))
* Add AutomergeReplicationAdapter with encrypted group spaces ([36274fb](https://github.com/antontranelis/web-of-trust/commit/36274fb2e2cab7458209f9a537dc59baa8925d39))
* Add blog with markdown articles and React Router ([5619d0b](https://github.com/antontranelis/web-of-trust/commit/5619d0bf504b817a5647fc351bb27b4067808cde))
* add CRDT benchmark suite — Automerge vs Yjs ([7b87305](https://github.com/antontranelis/web-of-trust/commit/7b873052030c615d285213f15d0aaef8806ce343))
* add early message buffer to WebSocketMessagingAdapter ([adb5190](https://github.com/antontranelis/web-of-trust/commit/adb519083f8cd3ed9d573edf7e1bb6b7c2f1a337))
* Add German BIP39 wordlist and fix identity persistence ([644634d](https://github.com/antontranelis/web-of-trust/commit/644634d60cbbca95aa21066d1b8c38058bfa47b9))
* add image to SpaceInfo + sync from _meta ([9676f12](https://github.com/antontranelis/web-of-trust/commit/9676f12f96bc2392dc63ed70ca1570af765d3c19))
* Add MessagingAdapter interface with InMemory implementation ([5075f66](https://github.com/antontranelis/web-of-trust/commit/5075f6655fdf339833db0172e570982f77b182cd))
* add modules field to SpaceInfo and _meta Map ([5adf142](https://github.com/antontranelis/web-of-trust/commit/5adf1423177a2cb23a5aa232051de1151fd3b98e))
* add PersistenceMetrics, Debug API + Debug Panel (Phase 1) ([c84edcb](https://github.com/antontranelis/web-of-trust/commit/c84edcb098cb4d2ae5dd1d7847566cec67745463))
* Add SecureWotIdentity with BIP39 + deterministic Ed25519 ([be3eebb](https://github.com/antontranelis/web-of-trust/commit/be3eebbd2005ac4296efd6a35b0acaabcab5c1b3))
* Add WebSocket relay server and WebSocketMessagingAdapter ([ff27bf7](https://github.com/antontranelis/web-of-trust/commit/ff27bf7c5ff7e7105b19a0fc3aa8103478f3a281))
* add YjsPersonalDocManager — pure JS alternative to Automerge ([b6d5b93](https://github.com/antontranelis/web-of-trust/commit/b6d5b9319ee9daf3939821fa37e9f2400231ef6d))
* add YjsPersonalSyncAdapter for encrypted multi-device sync ([5edf2aa](https://github.com/antontranelis/web-of-trust/commit/5edf2aaa087c0bd3c4b768f90b4ce740250b577a))
* add YjsReplicationAdapter for Spaces ([048f99d](https://github.com/antontranelis/web-of-trust/commit/048f99d049dc5bce33871ae3c8ffce3712dec838))
* CompactStore + SyncOnlyStorageAdapter + PersonalDoc migration (Phase 2-4) ([92dfb6c](https://github.com/antontranelis/web-of-trust/commit/92dfb6ce1ff12cb990340b6616e5782ebaf80104))
* CompactStore for Spaces + fix flaky E2E locator (Phase 5) ([35e8089](https://github.com/antontranelis/web-of-trust/commit/35e80897640ef3326babb649b9b7e732d33c1395))
* debug dashboard + relay challenge-response auth ([4894aa3](https://github.com/antontranelis/web-of-trust/commit/4894aa3efd0fca9c8e55a28a9fe735ff4de5e0d7))
* delivery acknowledgment protocol ([1ea9d08](https://github.com/antontranelis/web-of-trust/commit/1ea9d08533c43ceb68e15c05714c06156e5c6ca8))
* DiscoveryAdapter — 7th adapter for public profile discovery ([10db340](https://github.com/antontranelis/web-of-trust/commit/10db3402d39cf52f26b0f7bcdf035df58b0a7264))
* enable DebugPanel for Yjs adapter ([b64cd92](https://github.com/antontranelis/web-of-trust/commit/b64cd92c18ec850772793164b69de30bb7f27a48))
* Integrate Evolu storage with reactive live queries ([e2a83b4](https://github.com/antontranelis/web-of-trust/commit/e2a83b4c31501fca181e62e4d0efc318000e6eae))
* integrate Vault + Messaging into YjsPersonalDocManager ([9809d6b](https://github.com/antontranelis/web-of-trust/commit/9809d6b745a23e1ae6effc3f97cb8bb0d7a33184))
* make OutboxStore + SpaceMetadataStorage CRDT-agnostic via DI ([4975702](https://github.com/antontranelis/web-of-trust/commit/4975702430bf28c94e7088ac607672ae57e1ada3))
* messaging outbox for offline reliability + WebSocket heartbeat ([73e564a](https://github.com/antontranelis/web-of-trust/commit/73e564aabd17a8ad715c4fb4b78b79fb98e7bc0f))
* multi-device sync for group spaces ([6be1174](https://github.com/antontranelis/web-of-trust/commit/6be1174005789196222b7231d44cc879e02423da))
* offline-first discovery layer with dirty-flag tracking and profile caching ([55d82a3](https://github.com/antontranelis/web-of-trust/commit/55d82a3a22f543ef2a367e3093956634e6074931))
* Phase 3 foundations — asymmetric encryption, EncryptedSyncService, GroupKeyService ([f774980](https://github.com/antontranelis/web-of-trust/commit/f774980b9350120b46f5ea16d66f2d332374f75b))
* prepare @real-life/wot-core for npm publishing ([11e2fce](https://github.com/antontranelis/web-of-trust/commit/11e2fcea35e4b9b5b3ed15c4bb1e46cb7353fd2b))
* Profile Sync (Phase 1) + Symmetric Crypto (Phase 2) + Evolu cross-device sync ([75fd173](https://github.com/antontranelis/web-of-trust/commit/75fd17336cbf4837f199fea3fb9aa1dbf568d148))
* Public profile page + avatar/bio sync for contacts ([60ecc63](https://github.com/antontranelis/web-of-trust/commit/60ecc63d98ec478d44caf433ddc99bb4a38b4067))
* reactive identity + offline fallback for public profiles ([a5fdc3a](https://github.com/antontranelis/web-of-trust/commit/a5fdc3abb3890f69861ae062e6dc8733ae904995))
* reliable attestation delivery with async ACK and status tracking ([1e5ce05](https://github.com/antontranelis/web-of-trust/commit/1e5ce0588c8b2bf5b5c43bf41771e0e34de3e2b3))
* rename packages from [@web](https://github.com/web).of.trust/* to [@web](https://github.com/web)_of_trust/* ([85a0730](https://github.com/antontranelis/web-of-trust/commit/85a0730a553ba89761f779c894fd870f347d7dbc))
* rename packages from @real-life/* to [@web](https://github.com/web).of.trust/* ([9ddb159](https://github.com/antontranelis/web-of-trust/commit/9ddb159170d743fd0ae3f70993c981118fd8e4f2))
* self-hosted Evolu relay, bug fixes, CI pipeline, demo app tests ([f1db380](https://github.com/antontranelis/web-of-trust/commit/f1db3805758b670be2882e4ea1f8e4998f4ebb6d))
* Session cache with non-extractable CryptoKey in IndexedDB ([197c4aa](https://github.com/antontranelis/web-of-trust/commit/197c4aac960ed70d4d7b8b0323b59fe84eb7fb52))
* space metadata in shared Y.Doc (_meta map) + space management UI ([0c231b8](https://github.com/antontranelis/web-of-trust/commit/0c231b84a9d95e133dff716b950784df2da61041))
* space-sync-request for multi-device space discovery ([8515ed7](https://github.com/antontranelis/web-of-trust/commit/8515ed7968f545de418e43821e09e730b430e4c6))
* two-phase CompactStore save with CompactionService ([5c6a062](https://github.com/antontranelis/web-of-trust/commit/5c6a062e84472037e0a1c3bab330163c236e8490))
* VaultPushScheduler + relay peer count (Phase 1.5) ([8987cb3](https://github.com/antontranelis/web-of-trust/commit/8987cb3d26595f98015ae163eb413becb9c6780a))
* verification flow refactor — reactive mutual detection, spam protection, user confirmation ([21ba3b3](https://github.com/antontranelis/web-of-trust/commit/21ba3b390d7c14943e210f193cf78f79ef318af0))
* verification renewal, deferred counter-verification, pending verification UI ([e0bb590](https://github.com/antontranelis/web-of-trust/commit/e0bb590156316bcc534c8673368aa9d7772a5ab0))
* **wot-core:** Week 1 - SecureWotIdentity with BIP39 & deterministic Ed25519 ([4399d74](https://github.com/antontranelis/web-of-trust/commit/4399d74c3ce60551f2cb22fcd69512f2b45695e9))


### Bug Fixes

* add sync-request protocol to YjsPersonalSyncAdapter ([60250b0](https://github.com/antontranelis/web-of-trust/commit/60250b0b717735df702ce0fb676eeb1acb1cf346))
* add type assertions for CRDT-agnostic stores in wot-core ([e889ad0](https://github.com/antontranelis/web-of-trust/commit/e889ad088653dc3236fca9461fa0a73ea3119eae))
* auto-delete corrupt vault snapshots on decrypt failure ([557128f](https://github.com/antontranelis/web-of-trust/commit/557128fe201abcc96569f21bd7ebf7bd67599176))
* avoid writing undefined appTag to Automerge doc ([7021e7c](https://github.com/antontranelis/web-of-trust/commit/7021e7c958d23936ac23ee8feb0ab54428f91743))
* await IndexedDB compaction to ensure fast subsequent loads ([85afb43](https://github.com/antontranelis/web-of-trust/commit/85afb43d5eeb644f6a08df4f61423f55385412e8))
* check WebSocket readyState before sending ([9d9f9f0](https://github.com/antontranelis/web-of-trust/commit/9d9f9f0454ce238df4e68935963ccc5068a2f2fb))
* **ci:** catch unhandled rejection in AutomergeReplicationAdapter broadcast ([e3d0b09](https://github.com/antontranelis/web-of-trust/commit/e3d0b09022c5c5fba4b21f198b768a6334980a5c))
* Clarify implementation docs vs specification ([53d0f31](https://github.com/antontranelis/web-of-trust/commit/53d0f3156820ef99878edd3f71976d317e7ee526))
* compact IndexedDB on all load paths, repopulate vault after cleanup ([2c2c50d](https://github.com/antontranelis/web-of-trust/commit/2c2c50d0e9ab0ab0f8e33dcad64f34c62bb788ff))
* Delete all data when deleting identity ([c53786a](https://github.com/antontranelis/web-of-trust/commit/c53786a943ccc8c8633e58109290a855a3e2e5bb))
* Evolu relay, WebSocket state sync, attestation storage, verification dialog ([c3ba7f0](https://github.com/antontranelis/web-of-trust/commit/c3ba7f024566a341a6afb555509b4fb0ec3af5a5))
* guard WebSocket send against CONNECTING state race ([e5651c4](https://github.com/antontranelis/web-of-trust/commit/e5651c4a1de0fd76683bc0e76af05805b606e182))
* history-free compaction, background debounce, space metrics ([7a3837a](https://github.com/antontranelis/web-of-trust/commit/7a3837a33cc9489780be1d5ab9c93ba7124f6e6d))
* increase timeout for 1MB crypto test (flaky on CI) ([4b0e36f](https://github.com/antontranelis/web-of-trust/commit/4b0e36f14dedcba91ce6d16b14447a26a5ecc382))
* offline profile loading + attestation color coding ([f1423de](https://github.com/antontranelis/web-of-trust/commit/f1423dec69ac912e3b73fc69c496ea60c6fc68b0))
* ProfileResolveResult fromCache flag + verification dedup ([9089dc5](https://github.com/antontranelis/web-of-trust/commit/9089dc5d74e3c486641efa0091f5765d638899f9))
* recover from WASM crash on corrupt IndexedDB (capacity overflow) ([87b1d8f](https://github.com/antontranelis/web-of-trust/commit/87b1d8feb161d07aa75b6375102e1ac3ebf97c96))
* remove unused reject parameter (TS6133) ([7ec1dda](https://github.com/antontranelis/web-of-trust/commit/7ec1dda1c66f0df0dc50e4dc1698d880dfb54e40))
* remove unused variable in InMemoryMessagingAdapter (CI typecheck) ([bd2aff5](https://github.com/antontranelis/web-of-trust/commit/bd2aff5cd19d632a89ccea3c69b0990b250e8d65))
* restore original send() return value and receipt callbacks ([e891631](https://github.com/antontranelis/web-of-trust/commit/e8916314bd57dad0b822d9bcbeb4ca78ee70efd4))
* skip IndexedDB when too many chunks to prevent WASM OOM crash ([454976c](https://github.com/antontranelis/web-of-trust/commit/454976c8ade807fe07f93c9e2f0eca3ae107bf45))
* skip redundant vault pushes via Automerge heads dirty check ([3481d58](https://github.com/antontranelis/web-of-trust/commit/3481d589cbde7cb712d7c66a6dadc1cd7c65c8c4))
* Stabilize identity and sync with BIP39, Evolu owner management, and DB reset ([879b328](https://github.com/antontranelis/web-of-trust/commit/879b328cb764427c80a67fe0b854bf88271c8c04))
* vault sync optimization — Automerge.save(), outbox skip for CRDT messages ([648c362](https://github.com/antontranelis/web-of-trust/commit/648c3627dabfdf819a72fd2785e13a7033572c22))
* WebSocket onopen guard to prevent hanging connect Promise ([e8d726c](https://github.com/antontranelis/web-of-trust/commit/e8d726c27768af5b11da6017017463cce0075cb4))


### Performance Improvements

* deferred compaction on load + UI fixes ([f794b80](https://github.com/antontranelis/web-of-trust/commit/f794b80ae2ed9f0468aa8426a44694219afc315a))
* IndexedDB first, vault as fallback — eliminate unnecessary HTTP roundtrip ([a7e25c5](https://github.com/antontranelis/web-of-trust/commit/a7e25c541812c0a5fd2d72aeb6d203960c57c996))


### Reverts

* restore history-free compaction (revert perf experiments) ([19b2178](https://github.com/antontranelis/web-of-trust/commit/19b217824b25da99149976a153d09c59c6dac2bd))

## [0.2.1](https://github.com/antontranelis/web-of-trust/compare/@web_of_trust/core-v0.2.0...@web_of_trust/core-v0.2.1) (2026-03-26)


### Features

* add "Leave Space" button to Space detail page ([c8770c0](https://github.com/antontranelis/web-of-trust/commit/c8770c01b85e14fbfcd26a95351e86a2eedf4b24))
* Add AutomergeReplicationAdapter with encrypted group spaces ([36274fb](https://github.com/antontranelis/web-of-trust/commit/36274fb2e2cab7458209f9a537dc59baa8925d39))
* Add blog with markdown articles and React Router ([5619d0b](https://github.com/antontranelis/web-of-trust/commit/5619d0bf504b817a5647fc351bb27b4067808cde))
* add CRDT benchmark suite — Automerge vs Yjs ([7b87305](https://github.com/antontranelis/web-of-trust/commit/7b873052030c615d285213f15d0aaef8806ce343))
* add early message buffer to WebSocketMessagingAdapter ([adb5190](https://github.com/antontranelis/web-of-trust/commit/adb519083f8cd3ed9d573edf7e1bb6b7c2f1a337))
* Add German BIP39 wordlist and fix identity persistence ([644634d](https://github.com/antontranelis/web-of-trust/commit/644634d60cbbca95aa21066d1b8c38058bfa47b9))
* add image to SpaceInfo + sync from _meta ([9676f12](https://github.com/antontranelis/web-of-trust/commit/9676f12f96bc2392dc63ed70ca1570af765d3c19))
* Add MessagingAdapter interface with InMemory implementation ([5075f66](https://github.com/antontranelis/web-of-trust/commit/5075f6655fdf339833db0172e570982f77b182cd))
* add modules field to SpaceInfo and _meta Map ([5adf142](https://github.com/antontranelis/web-of-trust/commit/5adf1423177a2cb23a5aa232051de1151fd3b98e))
* add PersistenceMetrics, Debug API + Debug Panel (Phase 1) ([c84edcb](https://github.com/antontranelis/web-of-trust/commit/c84edcb098cb4d2ae5dd1d7847566cec67745463))
* Add SecureWotIdentity with BIP39 + deterministic Ed25519 ([be3eebb](https://github.com/antontranelis/web-of-trust/commit/be3eebbd2005ac4296efd6a35b0acaabcab5c1b3))
* Add WebSocket relay server and WebSocketMessagingAdapter ([ff27bf7](https://github.com/antontranelis/web-of-trust/commit/ff27bf7c5ff7e7105b19a0fc3aa8103478f3a281))
* add YjsPersonalDocManager — pure JS alternative to Automerge ([b6d5b93](https://github.com/antontranelis/web-of-trust/commit/b6d5b9319ee9daf3939821fa37e9f2400231ef6d))
* add YjsPersonalSyncAdapter for encrypted multi-device sync ([5edf2aa](https://github.com/antontranelis/web-of-trust/commit/5edf2aaa087c0bd3c4b768f90b4ce740250b577a))
* add YjsReplicationAdapter for Spaces ([048f99d](https://github.com/antontranelis/web-of-trust/commit/048f99d049dc5bce33871ae3c8ffce3712dec838))
* CompactStore + SyncOnlyStorageAdapter + PersonalDoc migration (Phase 2-4) ([92dfb6c](https://github.com/antontranelis/web-of-trust/commit/92dfb6ce1ff12cb990340b6616e5782ebaf80104))
* CompactStore for Spaces + fix flaky E2E locator (Phase 5) ([35e8089](https://github.com/antontranelis/web-of-trust/commit/35e80897640ef3326babb649b9b7e732d33c1395))
* debug dashboard + relay challenge-response auth ([4894aa3](https://github.com/antontranelis/web-of-trust/commit/4894aa3efd0fca9c8e55a28a9fe735ff4de5e0d7))
* delivery acknowledgment protocol ([1ea9d08](https://github.com/antontranelis/web-of-trust/commit/1ea9d08533c43ceb68e15c05714c06156e5c6ca8))
* DiscoveryAdapter — 7th adapter for public profile discovery ([10db340](https://github.com/antontranelis/web-of-trust/commit/10db3402d39cf52f26b0f7bcdf035df58b0a7264))
* enable DebugPanel for Yjs adapter ([b64cd92](https://github.com/antontranelis/web-of-trust/commit/b64cd92c18ec850772793164b69de30bb7f27a48))
* Integrate Evolu storage with reactive live queries ([e2a83b4](https://github.com/antontranelis/web-of-trust/commit/e2a83b4c31501fca181e62e4d0efc318000e6eae))
* integrate Vault + Messaging into YjsPersonalDocManager ([9809d6b](https://github.com/antontranelis/web-of-trust/commit/9809d6b745a23e1ae6effc3f97cb8bb0d7a33184))
* make OutboxStore + SpaceMetadataStorage CRDT-agnostic via DI ([4975702](https://github.com/antontranelis/web-of-trust/commit/4975702430bf28c94e7088ac607672ae57e1ada3))
* messaging outbox for offline reliability + WebSocket heartbeat ([73e564a](https://github.com/antontranelis/web-of-trust/commit/73e564aabd17a8ad715c4fb4b78b79fb98e7bc0f))
* multi-device sync for group spaces ([6be1174](https://github.com/antontranelis/web-of-trust/commit/6be1174005789196222b7231d44cc879e02423da))
* offline-first discovery layer with dirty-flag tracking and profile caching ([55d82a3](https://github.com/antontranelis/web-of-trust/commit/55d82a3a22f543ef2a367e3093956634e6074931))
* Phase 3 foundations — asymmetric encryption, EncryptedSyncService, GroupKeyService ([f774980](https://github.com/antontranelis/web-of-trust/commit/f774980b9350120b46f5ea16d66f2d332374f75b))
* prepare @real-life/wot-core for npm publishing ([11e2fce](https://github.com/antontranelis/web-of-trust/commit/11e2fcea35e4b9b5b3ed15c4bb1e46cb7353fd2b))
* Profile Sync (Phase 1) + Symmetric Crypto (Phase 2) + Evolu cross-device sync ([75fd173](https://github.com/antontranelis/web-of-trust/commit/75fd17336cbf4837f199fea3fb9aa1dbf568d148))
* Public profile page + avatar/bio sync for contacts ([60ecc63](https://github.com/antontranelis/web-of-trust/commit/60ecc63d98ec478d44caf433ddc99bb4a38b4067))
* reactive identity + offline fallback for public profiles ([a5fdc3a](https://github.com/antontranelis/web-of-trust/commit/a5fdc3abb3890f69861ae062e6dc8733ae904995))
* reliable attestation delivery with async ACK and status tracking ([1e5ce05](https://github.com/antontranelis/web-of-trust/commit/1e5ce0588c8b2bf5b5c43bf41771e0e34de3e2b3))
* rename packages from @real-life/* to [@web](https://github.com/web).of.trust/* ([9ddb159](https://github.com/antontranelis/web-of-trust/commit/9ddb159170d743fd0ae3f70993c981118fd8e4f2))
* self-hosted Evolu relay, bug fixes, CI pipeline, demo app tests ([f1db380](https://github.com/antontranelis/web-of-trust/commit/f1db3805758b670be2882e4ea1f8e4998f4ebb6d))
* Session cache with non-extractable CryptoKey in IndexedDB ([197c4aa](https://github.com/antontranelis/web-of-trust/commit/197c4aac960ed70d4d7b8b0323b59fe84eb7fb52))
* space metadata in shared Y.Doc (_meta map) + space management UI ([0c231b8](https://github.com/antontranelis/web-of-trust/commit/0c231b84a9d95e133dff716b950784df2da61041))
* space-sync-request for multi-device space discovery ([8515ed7](https://github.com/antontranelis/web-of-trust/commit/8515ed7968f545de418e43821e09e730b430e4c6))
* two-phase CompactStore save with CompactionService ([5c6a062](https://github.com/antontranelis/web-of-trust/commit/5c6a062e84472037e0a1c3bab330163c236e8490))
* VaultPushScheduler + relay peer count (Phase 1.5) ([8987cb3](https://github.com/antontranelis/web-of-trust/commit/8987cb3d26595f98015ae163eb413becb9c6780a))
* verification flow refactor — reactive mutual detection, spam protection, user confirmation ([21ba3b3](https://github.com/antontranelis/web-of-trust/commit/21ba3b390d7c14943e210f193cf78f79ef318af0))
* verification renewal, deferred counter-verification, pending verification UI ([e0bb590](https://github.com/antontranelis/web-of-trust/commit/e0bb590156316bcc534c8673368aa9d7772a5ab0))
* **wot-core:** Week 1 - SecureWotIdentity with BIP39 & deterministic Ed25519 ([4399d74](https://github.com/antontranelis/web-of-trust/commit/4399d74c3ce60551f2cb22fcd69512f2b45695e9))


### Bug Fixes

* add sync-request protocol to YjsPersonalSyncAdapter ([60250b0](https://github.com/antontranelis/web-of-trust/commit/60250b0b717735df702ce0fb676eeb1acb1cf346))
* add type assertions for CRDT-agnostic stores in wot-core ([e889ad0](https://github.com/antontranelis/web-of-trust/commit/e889ad088653dc3236fca9461fa0a73ea3119eae))
* auto-delete corrupt vault snapshots on decrypt failure ([557128f](https://github.com/antontranelis/web-of-trust/commit/557128fe201abcc96569f21bd7ebf7bd67599176))
* avoid writing undefined appTag to Automerge doc ([7021e7c](https://github.com/antontranelis/web-of-trust/commit/7021e7c958d23936ac23ee8feb0ab54428f91743))
* await IndexedDB compaction to ensure fast subsequent loads ([85afb43](https://github.com/antontranelis/web-of-trust/commit/85afb43d5eeb644f6a08df4f61423f55385412e8))
* check WebSocket readyState before sending ([9d9f9f0](https://github.com/antontranelis/web-of-trust/commit/9d9f9f0454ce238df4e68935963ccc5068a2f2fb))
* **ci:** catch unhandled rejection in AutomergeReplicationAdapter broadcast ([e3d0b09](https://github.com/antontranelis/web-of-trust/commit/e3d0b09022c5c5fba4b21f198b768a6334980a5c))
* Clarify implementation docs vs specification ([53d0f31](https://github.com/antontranelis/web-of-trust/commit/53d0f3156820ef99878edd3f71976d317e7ee526))
* compact IndexedDB on all load paths, repopulate vault after cleanup ([2c2c50d](https://github.com/antontranelis/web-of-trust/commit/2c2c50d0e9ab0ab0f8e33dcad64f34c62bb788ff))
* Delete all data when deleting identity ([c53786a](https://github.com/antontranelis/web-of-trust/commit/c53786a943ccc8c8633e58109290a855a3e2e5bb))
* Evolu relay, WebSocket state sync, attestation storage, verification dialog ([c3ba7f0](https://github.com/antontranelis/web-of-trust/commit/c3ba7f024566a341a6afb555509b4fb0ec3af5a5))
* guard WebSocket send against CONNECTING state race ([e5651c4](https://github.com/antontranelis/web-of-trust/commit/e5651c4a1de0fd76683bc0e76af05805b606e182))
* history-free compaction, background debounce, space metrics ([7a3837a](https://github.com/antontranelis/web-of-trust/commit/7a3837a33cc9489780be1d5ab9c93ba7124f6e6d))
* increase timeout for 1MB crypto test (flaky on CI) ([4b0e36f](https://github.com/antontranelis/web-of-trust/commit/4b0e36f14dedcba91ce6d16b14447a26a5ecc382))
* offline profile loading + attestation color coding ([f1423de](https://github.com/antontranelis/web-of-trust/commit/f1423dec69ac912e3b73fc69c496ea60c6fc68b0))
* ProfileResolveResult fromCache flag + verification dedup ([9089dc5](https://github.com/antontranelis/web-of-trust/commit/9089dc5d74e3c486641efa0091f5765d638899f9))
* recover from WASM crash on corrupt IndexedDB (capacity overflow) ([87b1d8f](https://github.com/antontranelis/web-of-trust/commit/87b1d8feb161d07aa75b6375102e1ac3ebf97c96))
* remove unused reject parameter (TS6133) ([7ec1dda](https://github.com/antontranelis/web-of-trust/commit/7ec1dda1c66f0df0dc50e4dc1698d880dfb54e40))
* remove unused variable in InMemoryMessagingAdapter (CI typecheck) ([bd2aff5](https://github.com/antontranelis/web-of-trust/commit/bd2aff5cd19d632a89ccea3c69b0990b250e8d65))
* restore original send() return value and receipt callbacks ([e891631](https://github.com/antontranelis/web-of-trust/commit/e8916314bd57dad0b822d9bcbeb4ca78ee70efd4))
* skip IndexedDB when too many chunks to prevent WASM OOM crash ([454976c](https://github.com/antontranelis/web-of-trust/commit/454976c8ade807fe07f93c9e2f0eca3ae107bf45))
* skip redundant vault pushes via Automerge heads dirty check ([3481d58](https://github.com/antontranelis/web-of-trust/commit/3481d589cbde7cb712d7c66a6dadc1cd7c65c8c4))
* Stabilize identity and sync with BIP39, Evolu owner management, and DB reset ([879b328](https://github.com/antontranelis/web-of-trust/commit/879b328cb764427c80a67fe0b854bf88271c8c04))
* vault sync optimization — Automerge.save(), outbox skip for CRDT messages ([648c362](https://github.com/antontranelis/web-of-trust/commit/648c3627dabfdf819a72fd2785e13a7033572c22))
* WebSocket onopen guard to prevent hanging connect Promise ([e8d726c](https://github.com/antontranelis/web-of-trust/commit/e8d726c27768af5b11da6017017463cce0075cb4))


### Performance Improvements

* deferred compaction on load + UI fixes ([f794b80](https://github.com/antontranelis/web-of-trust/commit/f794b80ae2ed9f0468aa8426a44694219afc315a))
* IndexedDB first, vault as fallback — eliminate unnecessary HTTP roundtrip ([a7e25c5](https://github.com/antontranelis/web-of-trust/commit/a7e25c541812c0a5fd2d72aeb6d203960c57c996))


### Reverts

* restore history-free compaction (revert perf experiments) ([19b2178](https://github.com/antontranelis/web-of-trust/commit/19b217824b25da99149976a153d09c59c6dac2bd))
