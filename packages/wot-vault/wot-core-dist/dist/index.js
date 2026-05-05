import { createResourceRef as r, parseResourceRef as t } from "./types/index.js";
import { i as s, s as i } from "./index-B966hEEj.js";
import { j as c, c as d, d as n, b as g, f as l, e as f, a as y, h as S, g as m, i as x, s as u, t as A, v as M } from "./jws-8PD3qxx2.js";
import { i as v } from "./index-DMs_nJMf.js";
import { W as I, i as P } from "./index-iLFZvtb2.js";
import { A as h, I as D, S as T, V as w, W as B, i as O } from "./index-WsYx1sRh.js";
import { c as V, d as L, e as R, v as E } from "./capabilities-BBiuFuYA.js";
import { signEnvelope as G, verifyEnvelope as J } from "./crypto/index.js";
import { P as H } from "./ProfileService-C_OznEb2.js";
import { AttestationDeliveryService as j, EncryptedSyncService as z, GraphCacheService as N, GroupKeyService as q, VaultClient as Q, VaultPushScheduler as X } from "./services/index.js";
import { W as Z } from "./WebCryptoAdapter-A_OiWZNL.js";
import { P as $, i as ee, H as ae, h as re, f as te, b as oe, I as se, d as ie, a as pe, e as ce, g as de, L as ne, O as ge, c as le, P as fe, i as ye, S as Se, T as me, W as xe } from "./TracedOutboxMessagingAdapter-nF4RqQb4.js";
import { CompactStorageManager as Ae, PersistenceMetrics as Me, TracedCompactStorageManager as be, getMetrics as ve, registerDebugApi as Ce } from "./storage/index.js";
import { T as Pe, g as We, r as he, t as De, a as Te } from "./TraceLog-CuKPT7Eo.js";
export {
  j as AttestationDeliveryService,
  h as AttestationWorkflow,
  $ as AutomergeOutboxStore,
  ee as AutomergeSpaceMetadataStorage,
  Ae as CompactStorageManager,
  z as EncryptedSyncService,
  N as GraphCacheService,
  q as GroupKeyService,
  ae as HttpDiscoveryAdapter,
  D as IdentityWorkflow,
  re as InMemoryAuthorizationAdapter,
  te as InMemoryCompactStore,
  oe as InMemoryGraphCacheStore,
  se as InMemoryMessagingAdapter,
  ie as InMemoryOutboxStore,
  pe as InMemoryPublishStateStore,
  ce as InMemorySpaceMetadataStorage,
  de as IndexedDBSpaceMetadataStorage,
  ne as LocalStorageAdapter,
  ge as OfflineFirstDiscoveryAdapter,
  le as OutboxMessagingAdapter,
  Me as PersistenceMetrics,
  fe as PersonalDocOutboxStore,
  ye as PersonalDocSpaceMetadataStorage,
  H as ProfileService,
  Se as SeedStorageIdentityVault,
  T as SpacesWorkflow,
  Pe as TraceLog,
  be as TracedCompactStorageManager,
  me as TracedOutboxMessagingAdapter,
  Q as VaultClient,
  X as VaultPushScheduler,
  w as VerificationWorkflow,
  Z as WebCryptoAdapter,
  I as WebCryptoProtocolCryptoAdapter,
  xe as WebSocketMessagingAdapter,
  B as WotIdentity,
  O as application,
  c as base64ToUint8,
  V as createCapability,
  d as createDid,
  r as createResourceRef,
  n as decodeBase58,
  g as decodeBase64Url,
  L as delegateCapability,
  l as didToPublicKeyBytes,
  f as encodeBase58,
  y as encodeBase64Url,
  R as extractCapability,
  S as extractJwsPayload,
  m as getDefaultDisplayName,
  ve as getMetrics,
  We as getTraceLog,
  x as isValidDid,
  t as parseResourceRef,
  s as ports,
  v as protocol,
  P as protocolAdapters,
  Ce as registerDebugApi,
  he as registerTraceApi,
  G as signEnvelope,
  u as signJws,
  i as skipFirst,
  A as toBuffer,
  De as traceAsync,
  Te as tracedFetch,
  E as verifyCapability,
  J as verifyEnvelope,
  M as verifyJws
};
