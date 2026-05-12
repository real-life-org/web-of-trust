import {
  formatBrokerChallengeNonce,
  parseBrokerChallengeNonce,
} from './broker-auth-nonce'

export const BROKER_REGISTER_CONTROL_FRAME_TYPE = 'register' as const
export const BROKER_CHALLENGE_CONTROL_FRAME_TYPE = 'challenge' as const
export const BROKER_REGISTERED_CONTROL_FRAME_TYPE = 'registered' as const

export interface BrokerRegisterControlFrame {
  type: typeof BROKER_REGISTER_CONTROL_FRAME_TYPE
  did: string
  deviceId: string
}

export interface BrokerChallengeControlFrame {
  type: typeof BROKER_CHALLENGE_CONTROL_FRAME_TYPE
  nonce: string
}

export interface ParsedBrokerChallengeControlFrame extends BrokerChallengeControlFrame {
  nonceBytes: Uint8Array
}

export interface BrokerRegisteredControlFrame {
  type: typeof BROKER_REGISTERED_CONTROL_FRAME_TYPE
  did: string
  deviceId: string
  isNewDevice: boolean
}

export interface CreateBrokerRegisterControlFrameOptions {
  did: string
  deviceId: string
}

export interface CreateBrokerChallengeControlFrameOptions {
  nonce: Uint8Array
}

export interface CreateBrokerRegisteredControlFrameOptions {
  did: string
  deviceId: string
  isNewDevice: boolean
}

/**
 * Creates the Sync 003 `register` Broker Control-Frame wire shape.
 *
 * Spec: wot-spec 03-wot-sync/003-transport-und-broker.md,
 * sections `Authentisierung` and `Broker Control-Frames (NORMATIV)`.
 *
 * This helper is intentionally limited to deterministic frame validation. It
 * does not bind WebSocket state, persist devices, resolve DIDs, or verify
 * Challenge-Response signatures.
 */
export function createBrokerRegisterControlFrame(
  options: CreateBrokerRegisterControlFrameOptions,
): BrokerRegisterControlFrame {
  return parseBrokerRegisterControlFrame({
    type: BROKER_REGISTER_CONTROL_FRAME_TYPE,
    did: options.did,
    deviceId: options.deviceId,
  })
}

// Spec: wot-spec 03-wot-sync/003-transport-und-broker.md,
// sections `Authentisierung` and `Broker Control-Frames (NORMATIV)`;
// parses the `register` control-frame.
export function parseBrokerRegisterControlFrame(value: unknown): BrokerRegisterControlFrame {
  const frame = assertRecord(value, 'broker register control-frame')
  assertTopLevelKeys(frame, ['type', 'did', 'deviceId'], 'broker register control-frame')
  assertRequiredOwnProperty(frame, 'type', 'broker register control-frame')
  assertRequiredOwnProperty(frame, 'did', 'broker register control-frame')
  assertRequiredOwnProperty(frame, 'deviceId', 'broker register control-frame')
  assertControlFrameType(
    frame.type,
    BROKER_REGISTER_CONTROL_FRAME_TYPE,
    'broker register control-frame',
  )

  return {
    type: BROKER_REGISTER_CONTROL_FRAME_TYPE,
    did: canonicalDid(frame.did, 'broker register control-frame did'),
    deviceId: canonicalDeviceId(frame.deviceId, 'broker register control-frame deviceId'),
  }
}

export function assertBrokerRegisterControlFrame(
  value: unknown,
): asserts value is BrokerRegisterControlFrame {
  parseBrokerRegisterControlFrame(value)
}

/**
 * Creates the Sync 003 `challenge` Broker Control-Frame wire shape from
 * caller-supplied nonce bytes. Randomness and issued-nonce storage remain
 * caller/runtime responsibilities.
 *
 * Spec: wot-spec 03-wot-sync/003-transport-und-broker.md,
 * sections `Authentisierung`, `Nonce-Handling (MUSS)`, and
 * `Broker Control-Frames (NORMATIV)`.
 */
export function createBrokerChallengeControlFrame(
  options: CreateBrokerChallengeControlFrameOptions,
): BrokerChallengeControlFrame {
  const parsed = parseBrokerChallengeControlFrame({
    type: BROKER_CHALLENGE_CONTROL_FRAME_TYPE,
    nonce: formatBrokerChallengeNonce(options.nonce),
  })

  return {
    type: parsed.type,
    nonce: parsed.nonce,
  }
}

// Spec: wot-spec 03-wot-sync/003-transport-und-broker.md,
// sections `Authentisierung`, `Nonce-Handling (MUSS)`, and
// `Broker Control-Frames (NORMATIV)`; parses the `challenge` control-frame.
export function parseBrokerChallengeControlFrame(
  value: unknown,
): ParsedBrokerChallengeControlFrame {
  const frame = assertRecord(value, 'broker challenge control-frame')
  assertTopLevelKeys(frame, ['type', 'nonce'], 'broker challenge control-frame')
  assertRequiredOwnProperty(frame, 'type', 'broker challenge control-frame')
  assertRequiredOwnProperty(frame, 'nonce', 'broker challenge control-frame')
  assertControlFrameType(
    frame.type,
    BROKER_CHALLENGE_CONTROL_FRAME_TYPE,
    'broker challenge control-frame',
  )
  if (typeof frame.nonce !== 'string') throw new Error('Invalid broker challenge control-frame nonce')

  const nonce = parseBrokerChallengeNonce(frame.nonce)
  return {
    type: BROKER_CHALLENGE_CONTROL_FRAME_TYPE,
    nonce: nonce.canonicalNonce,
    nonceBytes: nonce.bytes,
  }
}

export function assertBrokerChallengeControlFrame(
  value: unknown,
): asserts value is BrokerChallengeControlFrame {
  parseBrokerChallengeControlFrame(value)
}

/**
 * Creates the Sync 003 `registered` Broker Control-Frame wire shape. Device
 * list persistence and inbox delivery after registration stay out of
 * protocol-core scope.
 *
 * Spec: wot-spec 03-wot-sync/003-transport-und-broker.md,
 * sections `Erstregistrierung`, `Erneute Verbindung eines bekannten Devices`,
 * and `Broker Control-Frames (NORMATIV)`.
 */
export function createBrokerRegisteredControlFrame(
  options: CreateBrokerRegisteredControlFrameOptions,
): BrokerRegisteredControlFrame {
  return parseBrokerRegisteredControlFrame({
    type: BROKER_REGISTERED_CONTROL_FRAME_TYPE,
    did: options.did,
    deviceId: options.deviceId,
    isNewDevice: options.isNewDevice,
  })
}

// Spec: wot-spec 03-wot-sync/003-transport-und-broker.md,
// sections `Erstregistrierung`, `Erneute Verbindung eines bekannten Devices`,
// and `Broker Control-Frames (NORMATIV)`; parses the `registered` control-frame.
export function parseBrokerRegisteredControlFrame(value: unknown): BrokerRegisteredControlFrame {
  const frame = assertRecord(value, 'broker registered control-frame')
  assertTopLevelKeys(
    frame,
    ['type', 'did', 'deviceId', 'isNewDevice'],
    'broker registered control-frame',
  )
  assertRequiredOwnProperty(frame, 'type', 'broker registered control-frame')
  assertRequiredOwnProperty(frame, 'did', 'broker registered control-frame')
  assertRequiredOwnProperty(frame, 'deviceId', 'broker registered control-frame')
  assertRequiredOwnProperty(frame, 'isNewDevice', 'broker registered control-frame')
  assertControlFrameType(
    frame.type,
    BROKER_REGISTERED_CONTROL_FRAME_TYPE,
    'broker registered control-frame',
  )
  if (typeof frame.isNewDevice !== 'boolean') {
    throw new Error('Invalid broker registered control-frame isNewDevice')
  }

  return {
    type: BROKER_REGISTERED_CONTROL_FRAME_TYPE,
    did: canonicalDid(frame.did, 'broker registered control-frame did'),
    deviceId: canonicalDeviceId(frame.deviceId, 'broker registered control-frame deviceId'),
    isNewDevice: frame.isNewDevice,
  }
}

export function assertBrokerRegisteredControlFrame(
  value: unknown,
): asserts value is BrokerRegisteredControlFrame {
  parseBrokerRegisteredControlFrame(value)
}

function assertRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${name}`)
  return value as Record<string, unknown>
}

function assertTopLevelKeys(
  frame: Record<string, unknown>,
  allowedKeys: string[],
  name: string,
): void {
  const allowed = new Set(allowedKeys)
  for (const key of Reflect.ownKeys(frame)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`Invalid ${name} property: ${String(key)}`)
    }
  }
}

function assertRequiredOwnProperty(
  frame: Record<string, unknown>,
  key: string,
  name: string,
): void {
  if (!Object.prototype.hasOwnProperty.call(frame, key)) {
    throw new Error(`Invalid ${name} ${key}`)
  }
}

function assertControlFrameType<const T extends string>(
  value: unknown,
  expected: T,
  name: string,
): asserts value is T {
  if (value !== expected) throw new Error(`Invalid ${name} type`)
}

function canonicalDid(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid ${name}`)
  return value
}

function canonicalDeviceId(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  ) {
    throw new Error(`Invalid ${name}`)
  }
  return value
}
