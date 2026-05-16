import { createResourceRef as r, parseResourceRef as t } from "./types/index.js";
import { i as s, s as i } from "./index-B966hEEj.js";
import { n as c, j as d, c as n, d as l, b as g, l as f, f as S, e as y, a as m, m as u, h as x, g as A, i as M, s as b, t as v, k as C, v as I } from "./capabilities-BZPrEd2A.js";
import { i as h } from "./index-Dr9DQGWy.js";
import { i as T } from "./index-CUB0ip3A.js";
import { A as k, I as w, S as B, V as O, i as V } from "./index-BVoExInz.js";
import { signEnvelope as R, verifyEnvelope as j } from "./crypto/index.js";
import { P as F } from "./ProfileService-BL052r24.js";
import { AttestationDeliveryService as J, EncryptedSyncService as U, GraphCacheService as H, GroupKeyService as K, VaultClient as z, VaultPushScheduler as N } from "./services/index.js";
import { P as Q, j as X, H as Y, i as Z, g as _, c as $, I as ee, e as ae, b as re, f as te, h as oe, L as se, O as ie, d as pe, P as ce, j as de, S as ne, T as le, W as ge, a as fe } from "./TracedOutboxMessagingAdapter-BU92H76g.js";
import { CompactStorageManager as ye, PersistenceMetrics as me, TracedCompactStorageManager as ue, getMetrics as xe, registerDebugApi as Ae } from "./storage/index.js";
import { T as be, g as ve, r as Ce, t as Ie, a as Pe } from "./TraceLog-CuKPT7Eo.js";
import { W as De } from "./web-crypto-CV8VvS6t.js";
export {
  J as AttestationDeliveryService,
  k as AttestationWorkflow,
  Q as AutomergeOutboxStore,
  X as AutomergeSpaceMetadataStorage,
  ye as CompactStorageManager,
  U as EncryptedSyncService,
  H as GraphCacheService,
  K as GroupKeyService,
  Y as HttpDiscoveryAdapter,
  w as IdentityWorkflow,
  Z as InMemoryAuthorizationAdapter,
  _ as InMemoryCompactStore,
  $ as InMemoryGraphCacheStore,
  ee as InMemoryMessagingAdapter,
  ae as InMemoryOutboxStore,
  re as InMemoryPublishStateStore,
  te as InMemorySpaceMetadataStorage,
  oe as IndexedDBSpaceMetadataStorage,
  se as LocalStorageAdapter,
  ie as OfflineFirstDiscoveryAdapter,
  pe as OutboxMessagingAdapter,
  me as PersistenceMetrics,
  ce as PersonalDocOutboxStore,
  de as PersonalDocSpaceMetadataStorage,
  F as ProfileService,
  ne as SeedStorageIdentityVault,
  B as SpacesWorkflow,
  be as TraceLog,
  ue as TracedCompactStorageManager,
  le as TracedOutboxMessagingAdapter,
  z as VaultClient,
  N as VaultPushScheduler,
  O as VerificationWorkflow,
  ge as WebCryptoAdapter,
  De as WebCryptoProtocolCryptoAdapter,
  fe as WebSocketMessagingAdapter,
  V as application,
  c as base64ToUint8,
  d as createCapability,
  n as createDid,
  r as createResourceRef,
  l as decodeBase58,
  g as decodeBase64Url,
  f as delegateCapability,
  S as didToPublicKeyBytes,
  y as encodeBase58,
  m as encodeBase64Url,
  u as extractCapability,
  x as extractJwsPayload,
  A as getDefaultDisplayName,
  xe as getMetrics,
  ve as getTraceLog,
  M as isValidDid,
  t as parseResourceRef,
  s as ports,
  h as protocol,
  T as protocolAdapters,
  Ae as registerDebugApi,
  Ce as registerTraceApi,
  R as signEnvelope,
  b as signJws,
  i as skipFirst,
  v as toBuffer,
  Ie as traceAsync,
  Pe as tracedFetch,
  C as verifyCapability,
  j as verifyEnvelope,
  I as verifyJws
};
