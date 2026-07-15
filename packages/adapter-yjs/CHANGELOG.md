# Changelog

## [0.1.3](https://github.com/real-life-org/web-of-trust/compare/adapter-yjs-v0.1.2...adapter-yjs-v0.1.3) (2026-07-15)


### Features

* **1.B.3-key-rotation:** produktive Capability-JWS-Schicht + ECIES-Wire-Migration ([477a083](https://github.com/real-life-org/web-of-trust/commit/477a0835a48d067d45ca5d967c151f4897492ead))
* **1b3:** Yjs _members-Event-Set + createdBy, Backfill tot (Step 2) ([969456c](https://github.com/real-life-org/web-of-trust/commit/969456c46d120ccb5a52cc955f72acc6d08b46c0))
* **1b3:** Yjs Resolution/Cleanup + Generation-Gap (Steps 3+4) ([83475ec](https://github.com/real-life-org/web-of-trust/commit/83475ec9c28f32bc0930c8b6c3a0503e93e288b2))
* **adapter-yjs:** Inbox-Wire-Migration — DIDComm + Inner-JWS + ECIES + ack/1.0 (Referenz) ([ebacf5d](https://github.com/real-life-org/web-of-trust/commit/ebacf5d5ee0e3e3bd1bcc0a013df6715820d684e))
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
* **spaces:** echte Admin-Liste im synced Doc — 1.B.3-admin-management ([5ade33c](https://github.com/real-life-org/web-of-trust/commit/5ade33c77fc5c7a549d4237c99d542e92b00042a))
* **spaces:** echte Admin-Liste im synced Doc — 1.B.3-admin-management ([bff37c2](https://github.com/real-life-org/web-of-trust/commit/bff37c2ce2659472a68fefdba3b34de3dee715cc))
* **sync:** dual-broker Stage A — camp handshakes work anywhere (Sync 003 Multi-Broker) ([a6fa2cc](https://github.com/real-life-org/web-of-trust/commit/a6fa2ccee39af0b42116ae307243c1ae42605b60))
* **sync:** Dual-Broker Stufe A — Camp-Handshakes funktionieren überall ([6822f0b](https://github.com/real-life-org/web-of-trust/commit/6822f0b2ff79fa7e42a23296a227462e4fa1126c))
* **yjs+core:** blocked-by-key replay, restore-clone, personal-doc log sync, content-off, space-rotate (Slice A VE-5/6/7/10) ([556037d](https://github.com/real-life-org/web-of-trust/commit/556037dfea2de734893dcbbdf9f5737b8885699c))
* **yjs+core:** rewire Yjs content sync onto Sync-002 log-entry path (Slice A VE-2/3/4/8/9) ([9bd7ae0](https://github.com/real-life-org/web-of-trust/commit/9bd7ae0e5b203e82e82f1dd35613c33f86ee9c71))


### Bug Fixes

* **1b3:** address PR [#178](https://github.com/real-life-org/web-of-trust/issues/178) review findings (DI wiring + polish) ([ea7600e](https://github.com/real-life-org/web-of-trust/commit/ea7600e862538fe66e19f5a83f571098f2de4b48))
* **1b3:** publish empty /v and /a on offline-retry; untrack tsbuildinfo (Codex review [#198](https://github.com/real-life-org/web-of-trust/issues/198)) ([6f33008](https://github.com/real-life-org/web-of-trust/commit/6f3300886bdf9f7225e928810f3278f2b6e29655))
* **1b3:** re-derive isVerification from stored vcJws on storage read (review BLOCKER) ([6f3420f](https://github.com/real-life-org/web-of-trust/commit/6f3420ff44004ca8c1a57f6825c83ef5cafb8e84))
* **1b3:** resolution auch nach savePending + restore (Sync 005 Z.194, Review-M1) ([ccd8354](https://github.com/real-life-org/web-of-trust/commit/ccd83549a2562005295490ef2aafd737008082cc))
* **1b3:** review-nacharbeiten (Befund-Pin-Header, Drop-Logzeile, members[0]-Kommentare, Test-Flake-Härtung) ([54142e4](https://github.com/real-life-org/web-of-trust/commit/54142e48502ad24bfa0ce1f1027d2609c0409449))
* **1b3:** Yjs cleanup schliesst offene SpaceHandles (Codex-Re-Review M1) ([f9f8126](https://github.com/real-life-org/web-of-trust/commit/f9f81268f2bd71f0aec8ec2af39af265d390fa61))
* **1b3:** Yjs resolution-chain verkettet + members re-gelesen, enc-key-pruning (M1, MINOR-1) ([0e58690](https://github.com/real-life-org/web-of-trust/commit/0e5869049c77809be18da9b0a124f7013f48a79c))
* **adapters:** close B3 retry/idempotency hole — never treat local presence as durable proof (loop-review re-review) ([14babe0](https://github.com/real-life-org/web-of-trust/commit/14babe0c075257c810e58fc3cf70f80b906a92e5))
* **adapters:** drop the coordinator + replay-guard state on cleanupSpaceLocally (stale-coordinator, Yjs↔Automerge parity) ([a81c95c](https://github.com/real-life-org/web-of-trust/commit/a81c95cf06b5cf6360a87ce897e1761f36da824c))
* **adapters:** guard member-removal under enableLogSync as unsupported; remove half-built VE-10 broker-enforcement (Slice A) ([45771f1](https://github.com/real-life-org/web-of-trust/commit/45771f1928d851b005436480d858fba96df8f674))
* address yjs verification cleanup review ([c1f914f](https://github.com/real-life-org/web-of-trust/commit/c1f914fbb80ca25122042fc1230b8fc670040d2f))
* **core,adapters,test:** address loop-review (codex-gpt-5 + CodeRabbit) on PR [#214](https://github.com/real-life-org/web-of-trust/issues/214) ([50b4fd5](https://github.com/real-life-org/web-of-trust/commit/50b4fd5d341614d97767aa616ee66b5aed4380e7))
* **core,adapters:** Slice B v3 — close the multi-page-tail data-loss + 2 majors (3rd dual-review) ([0d64607](https://github.com/real-life-org/web-of-trust/commit/0d646072013ad44f75f72b24195de13538a2898f))
* **core,relay,adapters:** close 3 safety blockers + broker-url check from loop-review (Slice SR-3) ([0f25188](https://github.com/real-life-org/web-of-trust/commit/0f2518863f21dbbf924cb42aec497feabee80df7))
* **core,relay:** converge the legitimate lagger over real WS + route all write-path rejects (Slice SR-2, [#213](https://github.com/real-life-org/web-of-trust/issues/213)) ([4101225](https://github.com/real-life-org/web-of-trust/commit/41012259a8d73e373e969d1501d27d9385fb844d))
* **core+adapters:** close AES-GCM nonce-reuse blocker + churn/liveness concerns from dual review (Slice A) ([f71d2bd](https://github.com/real-life-org/web-of-trust/commit/f71d2bd306a04d27cd09a54902d5f0ab28877696))
* **core+adapters:** enforce member-removal at the broker via durable retriable space-rotate (Slice A VE-10 blocker) ([3cf4ee9](https://github.com/real-life-org/web-of-trust/commit/3cf4ee920df721b044ec612bd005cc7e126f5b1c))
* drop remote yjs verification maps ([18e5b5d](https://github.com/real-life-org/web-of-trust/commit/18e5b5d08b69eda643a8987041160902932ee16f))
* **inbox-wire:** message-id-history erst bei konklusiver Verarbeitung (Sync 003 Z.466) ([e92ecb4](https://github.com/real-life-org/web-of-trust/commit/e92ecb4b5d399d029406dadde8ec9cce2a72022a))
* **inbox-wire:** review-nacharbeiten (stale kommentare, VE-6-doku, space-invite-klassifikation, outbox-typen) ([d99d794](https://github.com/real-life-org/web-of-trust/commit/d99d7940770e57d1c0f5a7442b0658de5b0413f9))
* **key-rotation:** address [#189](https://github.com/real-life-org/web-of-trust/issues/189) review round 1 ([6f6a1ac](https://github.com/real-life-org/web-of-trust/commit/6f6a1ac02a59a9d444d8d7ac1aef48971233c1de))
* **member-update:** address [#188](https://github.com/real-life-org/web-of-trust/issues/188) re-review findings (store + adapters) ([aca1bca](https://github.com/real-life-org/web-of-trust/commit/aca1bca5d7c5938969cddedcb97b60e198cb01e4))
* rebuild yjs doc on remote legacy maps ([6e18d7c](https://github.com/real-life-org/web-of-trust/commit/6e18d7c76a121915402583df1db77fe41954e2e1))
* sanitize legacy yjs verification maps ([9aeb5b2](https://github.com/real-life-org/web-of-trust/commit/9aeb5b2773a3afdd5dcdf0cae6cb1d59b29f5c5d))
* **sync:** address PR-review blockers ([#234](https://github.com/real-life-org/web-of-trust/issues/234)) ([59c2ee1](https://github.com/real-life-org/web-of-trust/commit/59c2ee1da3094abceef9fe7724ab15ea18bd864d))
* **sync:** bot-review round — empty vaultUrl guard, per-field getDocInfo merge, carrying-broker metrics URL, monitor XSS escape ([1ff898b](https://github.com/real-life-org/web-of-trust/commit/1ff898bb91f77716fc695bc57a610ca9e728f493))
* **sync:** Eine Retry-Autorität für Log-Sync-Envelopes — Outbox-Orphans + Hard-Stop-Loop ([#236](https://github.com/real-life-org/web-of-trust/issues/236)) ([5396261](https://github.com/real-life-org/web-of-trust/commit/53962619f67e6165f4d3cf4140841fb49b5987c0))
* **sync:** persist+restore capability signing seed so a recovered device can write ([#234](https://github.com/real-life-org/web-of-trust/issues/234)) ([239bbd0](https://github.com/real-life-org/web-of-trust/commit/239bbd0a2b39fbf645c4cc50c59738f4b54c8d84))
* **sync:** recovered device can write to existing spaces — persist+restore capability signing seed ([#234](https://github.com/real-life-org/web-of-trust/issues/234)) ([2abc70c](https://github.com/real-life-org/web-of-trust/commit/2abc70c40451fc5ea160d0267aaa6069af903e46))
* **sync:** single retry authority for log-sync envelopes ([#236](https://github.com/real-life-org/web-of-trust/issues/236)) ([ee69f2a](https://github.com/real-life-org/web-of-trust/commit/ee69f2a5197209d9a299292b179c47f5cf9d8e90))
* **verification:** Yjs-Adapter re-derivt isVerification-Marker aus vcJws ([a5806a6](https://github.com/real-life-org/web-of-trust/commit/a5806a6b26b11997791cc983e50eb621d8a1c1b5))
* **verification:** Yjs-Adapter re-derivt isVerification-Marker aus vcJws ([2c626b1](https://github.com/real-life-org/web-of-trust/commit/2c626b1ce5f2a5734f129a095dde40c5d75ddfd1))

## [0.1.2](https://github.com/antontranelis/web-of-trust/compare/adapter-yjs-v0.1.1...adapter-yjs-v0.1.2) (2026-03-29)


### Features

* add image to SpaceInfo + sync from _meta ([9676f12](https://github.com/antontranelis/web-of-trust/commit/9676f12f96bc2392dc63ed70ca1570af765d3c19))
* add modules field to SpaceInfo and _meta Map ([5adf142](https://github.com/antontranelis/web-of-trust/commit/5adf1423177a2cb23a5aa232051de1151fd3b98e))
* allow all members to invite, only creator can remove ([5394d5a](https://github.com/antontranelis/web-of-trust/commit/5394d5a307cf0185c470c6f8c5ed9c24b6a4308b))
* content buffering for multi-device space discovery + offline test ([1e836fa](https://github.com/antontranelis/web-of-trust/commit/1e836fa082e05f5b85aebd9fac375c8470aa75ca))
* lazy PersonalDoc Vault-Pull on missing key (offline key rotation fix) ([42b651b](https://github.com/antontranelis/web-of-trust/commit/42b651bab93295273fd2b3510ee3cdbc5b97781e))
* multi-device sync for group spaces ([6be1174](https://github.com/antontranelis/web-of-trust/commit/6be1174005789196222b7231d44cc879e02423da))
* rename packages from [@web](https://github.com/web).of.trust/* to [@web](https://github.com/web)_of_trust/* ([85a0730](https://github.com/antontranelis/web-of-trust/commit/85a0730a553ba89761f779c894fd870f347d7dbc))
* rename packages from @real-life/* to [@web](https://github.com/web).of.trust/* ([9ddb159](https://github.com/antontranelis/web-of-trust/commit/9ddb159170d743fd0ae3f70993c981118fd8e4f2))
* sign all messages + encrypt member-update ([c72ed90](https://github.com/antontranelis/web-of-trust/commit/c72ed9034e5b1db693d8c93228c15edf369a3993))
* space metadata in shared Y.Doc (_meta map) + space management UI ([0c231b8](https://github.com/antontranelis/web-of-trust/commit/0c231b84a9d95e133dff716b950784df2da61041))
* space-sync-request for multi-device space discovery ([8515ed7](https://github.com/antontranelis/web-of-trust/commit/8515ed7968f545de418e43821e09e730b430e4c6))
* vault pull seq comparison + GroupKeyService reload + vault injection ([66c004f](https://github.com/antontranelis/web-of-trust/commit/66c004f6a637599911502bf7bff0f79100b191db))
* wire AuthorizationAdapter into YjsReplicationAdapter (Phase 1) ([2ba20df](https://github.com/antontranelis/web-of-trust/commit/2ba20dfab5f96c6c750061dd8aa57e66212a38f1))


### Bug Fixes

* adapter-yjs typecheck — non-null assertion on compactStore ([ac7a3f3](https://github.com/antontranelis/web-of-trust/commit/ac7a3f3fe6b757dd8cfff3295cee057bfbce486c))
* add missing deleteYjsPersonalDocDB export ([ad18414](https://github.com/antontranelis/web-of-trust/commit/ad18414d31885a80c58a1b1dcc622f19b576bcdc))
* add sender authorization check to YjsReplicationAdapter.handleMemberUpdate ([422d1bc](https://github.com/antontranelis/web-of-trust/commit/422d1bce995ba27ae109c342a317ac0f240794b5))
* auto-remove ghost spaces on restore + add wotDeleteSpace debug tool ([93357d4](https://github.com/antontranelis/web-of-trust/commit/93357d43db47c9e044be5f5bd931916339fe33bb))
* clear legacy outbox from PersonalDoc (saves ~2MB) ([a5a93ad](https://github.com/antontranelis/web-of-trust/commit/a5a93add570b23fd24d989d1b422e0132d573ee8))
* complete identity cleanup on logout + reset E2E tests ([95deefe](https://github.com/antontranelis/web-of-trust/commit/95deefe733a07356ae14b047e4a70baf3cd8ebea))
* eliminate sync storm on login — remove duplicate sync + cache vault 404s ([46b19ba](https://github.com/antontranelis/web-of-trust/commit/46b19bacbeceb464b2f152a2d91958c32bb3e596))
* flush PersonalDoc to Vault immediately after leaveSpace ([6a2e1cf](https://github.com/antontranelis/web-of-trust/commit/6a2e1cfc4179ccecbe4a87b825a8189713b1da61))
* handleMemberUpdate fallback to members[0] when sender capabilities unknown ([3bc565a](https://github.com/antontranelis/web-of-trust/commit/3bc565a7812f991a8a2a546fc2fdfa89cdf41aa3))
* persist group keys on createSpace + add leaveSpace cleanup ([0f9b6e3](https://github.com/antontranelis/web-of-trust/commit/0f9b6e3d9ec9a45646f2918bf9b3115f655428ac))
* PersonalDoc sync on reconnect — use onStateChange instead of missing onReconnect ([fe011a6](https://github.com/antontranelis/web-of-trust/commit/fe011a6d031e719103599117a11f14d19551f16a))
* prevent ghost spaces by skipping empty Y.Doc persistence ([33ddf5d](https://github.com/antontranelis/web-of-trust/commit/33ddf5dbceff764eeaf068164ae86f3cd6d5df90))
* push migration to vault + guard against outbox re-sync ([40138b3](https://github.com/antontranelis/web-of-trust/commit/40138b321495c02a0eba60cbf91cff70238c690b))
* rebuild PersonalDoc without outbox to actually reclaim space ([b6a0efd](https://github.com/antontranelis/web-of-trust/commit/b6a0efdd37324d0c06fafc8e450fb5cda5894da5))
* resolve typecheck error in PersonalDoc migration ([0ee9c54](https://github.com/antontranelis/web-of-trust/commit/0ee9c54f4fc7574a20ea246b5a6641475a3ce5d3))
* serialize via toJSON when rebuilding PersonalDoc ([1849cb5](https://github.com/antontranelis/web-of-trust/commit/1849cb5740c3b73039dcfa6d8e3c81fdbdb8badd))
* set Y.Map into parent before populating + persist migration ([bd782a7](https://github.com/antontranelis/web-of-trust/commit/bd782a7d97d9e8b43b5e965dc101701effd27f12))
* vault push after createSpace + checkMutualVerification after confirm ([704268c](https://github.com/antontranelis/web-of-trust/commit/704268cb55827594187b84f07da73fb2deee28b5))
* wotDeleteSpace persists immediately + debug logs for space restore ([779b680](https://github.com/antontranelis/web-of-trust/commit/779b68092420ad70d6e339d3477422bfaee74ac5))


### Performance Improvements

* add concurrency limit (3) for vault pulls ([d04fd91](https://github.com/antontranelis/web-of-trust/commit/d04fd9128362797ea7ce82b37e4b10f9a02c533f))
* remove blocking vault pulls from restoreSpacesFromMetadata ([b795ae7](https://github.com/antontranelis/web-of-trust/commit/b795ae7005d7b8de207f1fab8ed9d95863676e80))

## [0.1.1](https://github.com/antontranelis/web-of-trust/compare/@web_of_trust/adapter-yjs-v0.1.0...@web_of_trust/adapter-yjs-v0.1.1) (2026-03-26)


### Features

* add image to SpaceInfo + sync from _meta ([9676f12](https://github.com/antontranelis/web-of-trust/commit/9676f12f96bc2392dc63ed70ca1570af765d3c19))
* add modules field to SpaceInfo and _meta Map ([5adf142](https://github.com/antontranelis/web-of-trust/commit/5adf1423177a2cb23a5aa232051de1151fd3b98e))
* allow all members to invite, only creator can remove ([5394d5a](https://github.com/antontranelis/web-of-trust/commit/5394d5a307cf0185c470c6f8c5ed9c24b6a4308b))
* content buffering for multi-device space discovery + offline test ([1e836fa](https://github.com/antontranelis/web-of-trust/commit/1e836fa082e05f5b85aebd9fac375c8470aa75ca))
* lazy PersonalDoc Vault-Pull on missing key (offline key rotation fix) ([42b651b](https://github.com/antontranelis/web-of-trust/commit/42b651bab93295273fd2b3510ee3cdbc5b97781e))
* multi-device sync for group spaces ([6be1174](https://github.com/antontranelis/web-of-trust/commit/6be1174005789196222b7231d44cc879e02423da))
* rename packages from @real-life/* to [@web](https://github.com/web).of.trust/* ([9ddb159](https://github.com/antontranelis/web-of-trust/commit/9ddb159170d743fd0ae3f70993c981118fd8e4f2))
* sign all messages + encrypt member-update ([c72ed90](https://github.com/antontranelis/web-of-trust/commit/c72ed9034e5b1db693d8c93228c15edf369a3993))
* space metadata in shared Y.Doc (_meta map) + space management UI ([0c231b8](https://github.com/antontranelis/web-of-trust/commit/0c231b84a9d95e133dff716b950784df2da61041))
* space-sync-request for multi-device space discovery ([8515ed7](https://github.com/antontranelis/web-of-trust/commit/8515ed7968f545de418e43821e09e730b430e4c6))
* vault pull seq comparison + GroupKeyService reload + vault injection ([66c004f](https://github.com/antontranelis/web-of-trust/commit/66c004f6a637599911502bf7bff0f79100b191db))
* wire AuthorizationAdapter into YjsReplicationAdapter (Phase 1) ([2ba20df](https://github.com/antontranelis/web-of-trust/commit/2ba20dfab5f96c6c750061dd8aa57e66212a38f1))


### Bug Fixes

* adapter-yjs typecheck — non-null assertion on compactStore ([ac7a3f3](https://github.com/antontranelis/web-of-trust/commit/ac7a3f3fe6b757dd8cfff3295cee057bfbce486c))
* add missing deleteYjsPersonalDocDB export ([ad18414](https://github.com/antontranelis/web-of-trust/commit/ad18414d31885a80c58a1b1dcc622f19b576bcdc))
* add sender authorization check to YjsReplicationAdapter.handleMemberUpdate ([422d1bc](https://github.com/antontranelis/web-of-trust/commit/422d1bce995ba27ae109c342a317ac0f240794b5))
* auto-remove ghost spaces on restore + add wotDeleteSpace debug tool ([93357d4](https://github.com/antontranelis/web-of-trust/commit/93357d43db47c9e044be5f5bd931916339fe33bb))
* clear legacy outbox from PersonalDoc (saves ~2MB) ([a5a93ad](https://github.com/antontranelis/web-of-trust/commit/a5a93add570b23fd24d989d1b422e0132d573ee8))
* complete identity cleanup on logout + reset E2E tests ([95deefe](https://github.com/antontranelis/web-of-trust/commit/95deefe733a07356ae14b047e4a70baf3cd8ebea))
* eliminate sync storm on login — remove duplicate sync + cache vault 404s ([46b19ba](https://github.com/antontranelis/web-of-trust/commit/46b19bacbeceb464b2f152a2d91958c32bb3e596))
* flush PersonalDoc to Vault immediately after leaveSpace ([6a2e1cf](https://github.com/antontranelis/web-of-trust/commit/6a2e1cfc4179ccecbe4a87b825a8189713b1da61))
* handleMemberUpdate fallback to members[0] when sender capabilities unknown ([3bc565a](https://github.com/antontranelis/web-of-trust/commit/3bc565a7812f991a8a2a546fc2fdfa89cdf41aa3))
* persist group keys on createSpace + add leaveSpace cleanup ([0f9b6e3](https://github.com/antontranelis/web-of-trust/commit/0f9b6e3d9ec9a45646f2918bf9b3115f655428ac))
* PersonalDoc sync on reconnect — use onStateChange instead of missing onReconnect ([fe011a6](https://github.com/antontranelis/web-of-trust/commit/fe011a6d031e719103599117a11f14d19551f16a))
* prevent ghost spaces by skipping empty Y.Doc persistence ([33ddf5d](https://github.com/antontranelis/web-of-trust/commit/33ddf5dbceff764eeaf068164ae86f3cd6d5df90))
* push migration to vault + guard against outbox re-sync ([40138b3](https://github.com/antontranelis/web-of-trust/commit/40138b321495c02a0eba60cbf91cff70238c690b))
* rebuild PersonalDoc without outbox to actually reclaim space ([b6a0efd](https://github.com/antontranelis/web-of-trust/commit/b6a0efdd37324d0c06fafc8e450fb5cda5894da5))
* resolve typecheck error in PersonalDoc migration ([0ee9c54](https://github.com/antontranelis/web-of-trust/commit/0ee9c54f4fc7574a20ea246b5a6641475a3ce5d3))
* serialize via toJSON when rebuilding PersonalDoc ([1849cb5](https://github.com/antontranelis/web-of-trust/commit/1849cb5740c3b73039dcfa6d8e3c81fdbdb8badd))
* set Y.Map into parent before populating + persist migration ([bd782a7](https://github.com/antontranelis/web-of-trust/commit/bd782a7d97d9e8b43b5e965dc101701effd27f12))
* vault push after createSpace + checkMutualVerification after confirm ([704268c](https://github.com/antontranelis/web-of-trust/commit/704268cb55827594187b84f07da73fb2deee28b5))
* wotDeleteSpace persists immediately + debug logs for space restore ([779b680](https://github.com/antontranelis/web-of-trust/commit/779b68092420ad70d6e339d3477422bfaee74ac5))


### Performance Improvements

* add concurrency limit (3) for vault pulls ([d04fd91](https://github.com/antontranelis/web-of-trust/commit/d04fd9128362797ea7ce82b37e4b10f9a02c533f))
* remove blocking vault pulls from restoreSpacesFromMetadata ([b795ae7](https://github.com/antontranelis/web-of-trust/commit/b795ae7005d7b8de207f1fab8ed9d95863676e80))
