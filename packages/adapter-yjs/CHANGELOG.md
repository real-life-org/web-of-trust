# Changelog

## [0.1.3](https://github.com/real-life-org/web-of-trust/compare/adapter-yjs-v0.1.2...adapter-yjs-v0.1.3) (2026-04-27)


### Bug Fixes

* send full CRDT state to all members on reconnect (not just self) ([04aa16c](https://github.com/real-life-org/web-of-trust/commit/04aa16c83dae63c4c56e50d8743fbc222b9a2c28))

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
