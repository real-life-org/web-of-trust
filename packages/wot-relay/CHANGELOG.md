# Changelog

## [0.1.3](https://github.com/real-life-org/web-of-trust/compare/relay-v0.1.2...relay-v0.1.3) (2026-07-15)


### Features

* **1.B.3-key-rotation:** produktive Capability-JWS-Schicht + ECIES-Wire-Migration ([477a083](https://github.com/real-life-org/web-of-trust/commit/477a0835a48d067d45ca5d967c151f4897492ead))
* **core,relay,adapters:** KEY_GENERATION_STALE re-emit for the legitimate lagger (Slice SR VE-C2) ([2e9c150](https://github.com/real-life-org/web-of-trust/commit/2e9c15041109f52d232dbc71d9f09223dabe9099))
* **e2e:** Spur-C remote-relay enablement + read-only relay stats (D1) ([12c9757](https://github.com/real-life-org/web-of-trust/commit/12c975781836800c4f2964039df5b3ef261d75ab))
* **inbox-wire:** relay to[0]-routing + ack/1.0-mapping (Step 7b) ([7c326bd](https://github.com/real-life-org/web-of-trust/commit/7c326bd638a18fac649e727b10da547d16db4e2a))
* **relay:** A2 Teil B — Personal-Doc TOFU owner-binding + dashboard docId redaction ([5d18959](https://github.com/real-life-org/web-of-trust/commit/5d18959b43273da3923cb88453886169017cc8eb))
* **relay:** add always-public shortened `display` block to /dashboard/data ([252106b](https://github.com/real-life-org/web-of-trust/commit/252106b7a3a00e0066b2716afd406343373a08ff))
* **relay:** bind deviceId↔authorKid first-writer-wins (Slice R VE-3a) ([413e1f3](https://github.com/real-life-org/web-of-trust/commit/413e1f36ef7ba66b872d375e8b104bc2b07c2c59))
* **relay:** capability gate — present-capability + scope cache + write/read gate (Slice CG Phase 4, VE-4/5/8) ([a3dcaf0](https://github.com/real-life-org/web-of-trust/commit/a3dcaf0fea408515b27d59898c69043d57df2648))
* **relay:** capability-gate + full-rotation + author-binding (Slice CG, WIP) ([f463e5b](https://github.com/real-life-org/web-of-trust/commit/f463e5bb402902d3bf926a05e745f5c266dc2fdf))
* **relay:** dashboard card explainers (i-buttons) + disk fill-level donut ([9e2232b](https://github.com/real-life-org/web-of-trust/commit/9e2232b9defa03b6da4a22c7ce718080191868a0))
* **relay:** durable append-only log store + sync-request catch-up (Slice R) ([ea6ee5f](https://github.com/real-life-org/web-of-trust/commit/ea6ee5f23dcda32ebe4e803f0d4dfd77517a3e98))
* **relay:** durable append-only log store + sync-request catch-up (Slice R) ([3b32b25](https://github.com/real-life-org/web-of-trust/commit/3b32b256d65048846332f95317cf0925455039c6))
* **relay:** durable device list + device-revoke + spec author-binding (Slice CG Phase 2, VE-1/2) ([543e2de](https://github.com/real-life-org/web-of-trust/commit/543e2de4994c4c7ffb9f669e63c8bb4adf50870e))
* **relay:** generisches Broker-Dashboard — schöne Oberfläche auf jedem Relay ([da58098](https://github.com/real-life-org/web-of-trust/commit/da58098ca864a7a5d0b3af397ce8f15b9286cdfb))
* **relay:** history graphs on the broker dashboard ([7e729ec](https://github.com/real-life-org/web-of-trust/commit/7e729eca2bf5736fe61e809e8e544ccc5a53f54d))
* **relay:** ingest generation-gate + relay whitelist for secure removal (Slice SR VE-R1/VE-R2) ([55c280f](https://github.com/real-life-org/web-of-trust/commit/55c280f55e18138d0436db80996c520525adb5cc))
* **relay:** metrics ring + host stats + /dashboard/metrics endpoint ([2a8e670](https://github.com/real-life-org/web-of-trust/commit/2a8e670e96c1d42fe365ee07dcdb42b9a29a758f))
* **relay:** Metriken-Ring + Pi-Host-Stats + Verlaufs-Graphen (stacked auf [#256](https://github.com/real-life-org/web-of-trust/issues/256)) ([ee9068a](https://github.com/real-life-org/web-of-trust/commit/ee9068a487192b42740beffd9ca333ef810cd771))
* **relay:** multi-device inbox store-and-forward (per-device ack, Sync 003 §Store-and-Forward) ([6b6fb21](https://github.com/real-life-org/web-of-trust/commit/6b6fb21141c4855b1e511e90140fc860fd56e01d))
* **relay:** rewrite /dashboard as a calm dark broker dashboard ([91dfa69](https://github.com/real-life-org/web-of-trust/commit/91dfa6912b71a13a5ffe2b9af6e62d00fd579ca7))
* **relay:** space-register control-frame + durable space registry (Slice CG Phase 3, VE-3) ([166fcf6](https://github.com/real-life-org/web-of-trust/commit/166fcf6c901b05d0b0e3d85a6937802907e10b10))
* **relay:** space-rotate + cross-socket cache invalidation + admin-add/remove (Slice CG Phase 5, VE-6/7) ([8618b98](https://github.com/real-life-org/web-of-trust/commit/8618b981f68613e1c83c31f407a7dcfc49a8d758))
* **transport:** WireMessage-Union, K1-Auto-ACK-Guard, Relay to[0]-Routing + ack/1.0-Mapping ([6ba89b5](https://github.com/real-life-org/web-of-trust/commit/6ba89b540488f21387f63c0894133f021cbfcebd))


### Bug Fixes

* **1b3:** publish empty /v and /a on offline-retry; untrack tsbuildinfo (Codex review [#198](https://github.com/real-life-org/web-of-trust/issues/198)) ([6f33008](https://github.com/real-life-org/web-of-trust/commit/6f3300886bdf9f7225e928810f3278f2b6e29655))
* **1b3:** re-derive isVerification from stored vcJws on storage read (review BLOCKER) ([6f3420f](https://github.com/real-life-org/web-of-trust/commit/6f3420ff44004ca8c1a57f6825c83ef5cafb8e84))
* **core,relay,adapters:** close 3 safety blockers + broker-url check from loop-review (Slice SR-3) ([0f25188](https://github.com/real-life-org/web-of-trust/commit/0f2518863f21dbbf924cb42aec497feabee80df7))
* **core,relay,adapters:** close the 3 CodeRabbit Non-Security findings + minors (Slice SR-4) ([91bce7f](https://github.com/real-life-org/web-of-trust/commit/91bce7f1391990b68cd32a247cc7e948bf7d4223))
* **core,relay:** converge the legitimate lagger over real WS + route all write-path rejects (Slice SR-2, [#213](https://github.com/real-life-org/web-of-trust/issues/213)) ([4101225](https://github.com/real-life-org/web-of-trust/commit/41012259a8d73e373e969d1501d27d9385fb844d))
* **docker:** relay+profiles bauen [@web](https://github.com/web)_of_trust/core aus dem Workspace ([76adf02](https://github.com/real-life-org/web-of-trust/commit/76adf0252078e8fcdacb92136e02c99751d05ac1))
* **relay:** address inbox store-and-forward review findings (GC wiring, fan-out/completeness alignment, id-less key) ([6d3d552](https://github.com/real-life-org/web-of-trust/commit/6d3d55244e5f7374d771075df16d6021508688c9))
* **relay:** bind Personal→Space upgrade to the SIGNER, not adminDids membership ([9beef57](https://github.com/real-life-org/web-of-trust/commit/9beef571714e0a8e89ae27dd1732356d23f525c6))
* **relay:** close 3 authorization-boundary blockers + 2 should-fixes from codex rereview (Slice CG) ([588e941](https://github.com/real-life-org/web-of-trust/commit/588e9416d837ce233d4442469ce2c0733d8b2bb6))
* **relay:** close 3 review blockers — GC unreachable, revoked-sender inbox bypass, divergent messageId collision ([a2560ee](https://github.com/real-life-org/web-of-trust/commit/a2560eeeaff3faba465a8c45c1d73b25dd644b43))
* **relay:** control-frame-ACK respektiert DIDComm-ack-Ownership (Review-Blocker) ([f7094a4](https://github.com/real-life-org/web-of-trust/commit/f7094a4b1dcbea57a243e67e2528e1b089a1532e))
* **relay:** dashboard defaults to shortened display ids; full ids only flag-gated ([92daa07](https://github.com/real-life-org/web-of-trust/commit/92daa079ec7ec9cd7eb98f5bab1f505458d3b9d8))
* **relay:** drop redundant pre-build/test/typecheck hooks that raced turbo (CI green) ([3b5d8bd](https://github.com/real-life-org/web-of-trust/commit/3b5d8bd9ddf04dd00e76f8d869de782057b763f2))
* **relay:** gate sensitive /dashboard/data stats behind RELAY_DEBUG_STATS + review should-fixes ([9632ff2](https://github.com/real-life-org/web-of-trust/commit/9632ff2b963cb6377e2ca15d0ce55ea9a4324682))
* **relay:** keyed docId shortcuts (per-process salt) + SQL-limited display queries ([78fbd63](https://github.com/real-life-org/web-of-trust/commit/78fbd6326f8aa3fcbe0c7e8170c8aeb385957b7c))
* **relay:** payload-JCS content-hash + default sync-request limit 100 (Slice R) ([59dc0c4](https://github.com/real-life-org/web-of-trust/commit/59dc0c47af2667c59a7661cd9eef0fe83f377aa3))
* **relay:** Personal→Space-Upgrade an den SIGNER binden (Anti-Escalation härten) ([22ee815](https://github.com/real-life-org/web-of-trust/commit/22ee81526c56f78b86b1019e360c48cf73dee36e))
* **relay:** readable history-chart axes — zero baseline, nice ticks, real-pixel labels ([bbb7c04](https://github.com/real-life-org/web-of-trust/commit/bbb7c0484d1670eb89ca0166f67239c48a82ce85))
* **relay:** strictly monotonic metric bucket times + gap-preserving downsampling ([2ce03e3](https://github.com/real-life-org/web-of-trust/commit/2ce03e393179e26fdd570541b4946b82ca60836c))
* **relay:** use the WebView-safe timeout fallback in tickMetrics too ([d5edf31](https://github.com/real-life-org/web-of-trust/commit/d5edf31e831367bcbd25f52dbcb59393eba32de7))
* **test:** bind port:0 + read bound port to remove free-port TOCTOU flake ([f512e10](https://github.com/real-life-org/web-of-trust/commit/f512e10534728d691ccef308ef5b7f06c83feb99))

## [0.1.2](https://github.com/antontranelis/web-of-trust/compare/relay-v0.1.1...relay-v0.1.2) (2026-03-29)


### Features

* Add blog with markdown articles and React Router ([5619d0b](https://github.com/antontranelis/web-of-trust/commit/5619d0bf504b817a5647fc351bb27b4067808cde))
* Add WebSocket relay server and WebSocketMessagingAdapter ([ff27bf7](https://github.com/antontranelis/web-of-trust/commit/ff27bf7c5ff7e7105b19a0fc3aa8103478f3a281))
* Connect demo app to WebSocket relay for live attestation delivery ([b342dfe](https://github.com/antontranelis/web-of-trust/commit/b342dfeaac7a0682046b5560ae04a10befc50887))
* debug dashboard + relay challenge-response auth ([4894aa3](https://github.com/antontranelis/web-of-trust/commit/4894aa3efd0fca9c8e55a28a9fe735ff4de5e0d7))
* delivery acknowledgment protocol ([1ea9d08](https://github.com/antontranelis/web-of-trust/commit/1ea9d08533c43ceb68e15c05714c06156e5c6ca8))
* messaging outbox for offline reliability + WebSocket heartbeat ([73e564a](https://github.com/antontranelis/web-of-trust/commit/73e564aabd17a8ad715c4fb4b78b79fb98e7bc0f))
* Profile management, recovery UX, relay deployment config ([fd90cbd](https://github.com/antontranelis/web-of-trust/commit/fd90cbdad73d529b9dd54f617f6cfec6576f90f9))
* relay multi-device support ([2c4a1f3](https://github.com/antontranelis/web-of-trust/commit/2c4a1f36ac0d9ddc95c03bb3a91d956c685cc731))
* rename packages from [@web](https://github.com/web).of.trust/* to [@web](https://github.com/web)_of_trust/* ([85a0730](https://github.com/antontranelis/web-of-trust/commit/85a0730a553ba89761f779c894fd870f347d7dbc))
* rename packages from @real-life/* to [@web](https://github.com/web).of.trust/* ([9ddb159](https://github.com/antontranelis/web-of-trust/commit/9ddb159170d743fd0ae3f70993c981118fd8e4f2))
* VaultPushScheduler + relay peer count (Phase 1.5) ([8987cb3](https://github.com/antontranelis/web-of-trust/commit/8987cb3d26595f98015ae163eb413becb9c6780a))


### Bug Fixes

* **ci:** resolve port conflict between wot-relay and wot-profiles tests ([0fae15f](https://github.com/antontranelis/web-of-trust/commit/0fae15ff11bf5fc431dca0f8da5e884592d9d528))
* relay tests for challenge-response auth ([f60c0e7](https://github.com/antontranelis/web-of-trust/commit/f60c0e7e8dd1e307fd48477a410381251ece85b2))
* relay TypeScript strict BufferSource compatibility ([2b45169](https://github.com/antontranelis/web-of-trust/commit/2b45169e578b456b6837b691f98f734ef3825ae9))
* SPA routing under /demo base path + env config ([919c3e7](https://github.com/antontranelis/web-of-trust/commit/919c3e74a938ed1e859b415946fa810e58e0f0a6))
* use 'as any' for crypto.subtle in Docker TS environment ([a867e80](https://github.com/antontranelis/web-of-trust/commit/a867e805a8fb88a91d8a6ff4fbf228718203d642))
* use ArrayBuffer instead of Uint8Array for crypto.subtle calls ([2a9c364](https://github.com/antontranelis/web-of-trust/commit/2a9c364d261885f22bfe41bbe378fc96ad130ed6))

## [0.1.1](https://github.com/antontranelis/web-of-trust/compare/@web_of_trust/relay-v0.1.0...@web_of_trust/relay-v0.1.1) (2026-03-26)


### Features

* Add blog with markdown articles and React Router ([5619d0b](https://github.com/antontranelis/web-of-trust/commit/5619d0bf504b817a5647fc351bb27b4067808cde))
* Add WebSocket relay server and WebSocketMessagingAdapter ([ff27bf7](https://github.com/antontranelis/web-of-trust/commit/ff27bf7c5ff7e7105b19a0fc3aa8103478f3a281))
* Connect demo app to WebSocket relay for live attestation delivery ([b342dfe](https://github.com/antontranelis/web-of-trust/commit/b342dfeaac7a0682046b5560ae04a10befc50887))
* debug dashboard + relay challenge-response auth ([4894aa3](https://github.com/antontranelis/web-of-trust/commit/4894aa3efd0fca9c8e55a28a9fe735ff4de5e0d7))
* delivery acknowledgment protocol ([1ea9d08](https://github.com/antontranelis/web-of-trust/commit/1ea9d08533c43ceb68e15c05714c06156e5c6ca8))
* messaging outbox for offline reliability + WebSocket heartbeat ([73e564a](https://github.com/antontranelis/web-of-trust/commit/73e564aabd17a8ad715c4fb4b78b79fb98e7bc0f))
* Profile management, recovery UX, relay deployment config ([fd90cbd](https://github.com/antontranelis/web-of-trust/commit/fd90cbdad73d529b9dd54f617f6cfec6576f90f9))
* relay multi-device support ([2c4a1f3](https://github.com/antontranelis/web-of-trust/commit/2c4a1f36ac0d9ddc95c03bb3a91d956c685cc731))
* rename packages from @real-life/* to [@web](https://github.com/web).of.trust/* ([9ddb159](https://github.com/antontranelis/web-of-trust/commit/9ddb159170d743fd0ae3f70993c981118fd8e4f2))
* VaultPushScheduler + relay peer count (Phase 1.5) ([8987cb3](https://github.com/antontranelis/web-of-trust/commit/8987cb3d26595f98015ae163eb413becb9c6780a))


### Bug Fixes

* **ci:** resolve port conflict between wot-relay and wot-profiles tests ([0fae15f](https://github.com/antontranelis/web-of-trust/commit/0fae15ff11bf5fc431dca0f8da5e884592d9d528))
* relay tests for challenge-response auth ([f60c0e7](https://github.com/antontranelis/web-of-trust/commit/f60c0e7e8dd1e307fd48477a410381251ece85b2))
* relay TypeScript strict BufferSource compatibility ([2b45169](https://github.com/antontranelis/web-of-trust/commit/2b45169e578b456b6837b691f98f734ef3825ae9))
* SPA routing under /demo base path + env config ([919c3e7](https://github.com/antontranelis/web-of-trust/commit/919c3e74a938ed1e859b415946fa810e58e0f0a6))
* use 'as any' for crypto.subtle in Docker TS environment ([a867e80](https://github.com/antontranelis/web-of-trust/commit/a867e805a8fb88a91d8a6ff4fbf228718203d642))
* use ArrayBuffer instead of Uint8Array for crypto.subtle calls ([2a9c364](https://github.com/antontranelis/web-of-trust/commit/2a9c364d261885f22bfe41bbe378fc96ad130ed6))
