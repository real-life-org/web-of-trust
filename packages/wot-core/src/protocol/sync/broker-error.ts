// Spec: Sync 003 `Fehler-Responses` defines this catalog and the two explicit client actions below.
// The `error/1.0` control-frame shape lives in broker-control-frame.ts; wot-spec#36 tracks the prior envelope-shape ambiguity.
// Order mirrors the Sync 003 `Fehler-Responses` table (003-transport-und-broker.md
// Normative Error-Codes) one-to-one so this catalog stays an honest closed set:
// `parseBrokerErrorBody`/`isKnownBrokerErrorCode` reject any code outside it.
export const KNOWN_BROKER_ERROR_CODES = Object.freeze([
  'DOC_NOT_FOUND',
  'CAPABILITY_REQUIRED',
  'CAPABILITY_INVALID',
  'CAPABILITY_EXPIRED',
  'CAPABILITY_GENERATION_STALE',
  'SPACE_ALREADY_REGISTERED',
  'AUTHOR_MISMATCH',
  'DEVICE_NOT_REGISTERED',
  'DEVICE_REVOKED',
  'DEVICE_ID_CONFLICT',
  'SEQ_COLLISION_DETECTED',
  'KEY_GENERATION_STALE',
  'MALFORMED_MESSAGE',
  'AUTH_INVALID',
  'NONCE_REPLAY',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const)

export type BrokerErrorCode = (typeof KNOWN_BROKER_ERROR_CODES)[number]

export interface BrokerErrorBody {
  code: BrokerErrorCode
  message: string
  [key: string]: unknown
}

// Keys are TypeScript-friendly; values are kebab-case for logs and telemetry.
export const BROKER_ERROR_CLIENT_ACTIONS = {
  restoreCloneRecovery: 'restore-clone-recovery',
  requestFreshCapabilityViaPeerContact: 'request-fresh-capability-via-peer-contact',
  noNormativeAction: 'no-normative-action',
} as const

export type BrokerErrorClientAction =
  (typeof BROKER_ERROR_CLIENT_ACTIONS)[keyof typeof BROKER_ERROR_CLIENT_ACTIONS]

const KNOWN_BROKER_ERROR_CODE_SET = new Set<string>(KNOWN_BROKER_ERROR_CODES)

export function isKnownBrokerErrorCode(value: unknown): value is BrokerErrorCode {
  return typeof value === 'string' && KNOWN_BROKER_ERROR_CODE_SET.has(value)
}

export function assertKnownBrokerErrorCode(value: unknown): asserts value is BrokerErrorCode {
  if (!isKnownBrokerErrorCode(value)) {
    throw new Error('Unknown wot-sync@0.1 broker error code')
  }
}

export function parseBrokerErrorBody(value: unknown): BrokerErrorBody {
  const body = assertRecord(value, 'broker error body')
  assertOwnProperty(body, 'code', 'broker error code')
  assertOwnProperty(body, 'message', 'broker error message')
  assertKnownBrokerErrorCode(body.code)
  assertHumanReadableMessage(body.message)
  return { ...body } as BrokerErrorBody
}

export function classifyBrokerErrorClientAction(code: unknown): BrokerErrorClientAction {
  assertKnownBrokerErrorCode(code)

  if (code === 'SEQ_COLLISION_DETECTED') return BROKER_ERROR_CLIENT_ACTIONS.restoreCloneRecovery
  if (code === 'CAPABILITY_EXPIRED') return BROKER_ERROR_CLIENT_ACTIONS.requestFreshCapabilityViaPeerContact
  return BROKER_ERROR_CLIENT_ACTIONS.noNormativeAction
}

function assertRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${name}`)
  return value as Record<string, unknown>
}

function assertOwnProperty(record: Record<string, unknown>, key: string, name: string): void {
  if (!Object.prototype.hasOwnProperty.call(record, key)) throw new Error(`Invalid ${name}`)
}

function assertHumanReadableMessage(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Invalid broker error message')
  }
}
