// Spec: Sync 003 `Fehler-Responses` defines this catalog and the two explicit client actions below.
// [NEEDS CLARIFICATION: Sync 003 error response envelope shape; wot-spec#36] Full `error/1.0` envelope parsing is out of scope here.
export const KNOWN_BROKER_ERROR_CODES = Object.freeze([
  'DOC_NOT_FOUND',
  'CAPABILITY_INVALID',
  'CAPABILITY_EXPIRED',
  'CAPABILITY_GENERATION_STALE',
  'DEVICE_NOT_REGISTERED',
  'DEVICE_REVOKED',
  'DEVICE_ID_CONFLICT',
  'SEQ_COLLISION_DETECTED',
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
  assertKnownBrokerErrorCode(body.code)
  assertHumanReadableMessage(body.message)
  return body as BrokerErrorBody
}

export function classifyBrokerErrorClientAction(code: BrokerErrorCode): BrokerErrorClientAction {
  if (code === 'SEQ_COLLISION_DETECTED') return BROKER_ERROR_CLIENT_ACTIONS.restoreCloneRecovery
  if (code === 'CAPABILITY_EXPIRED') return BROKER_ERROR_CLIENT_ACTIONS.requestFreshCapabilityViaPeerContact
  return BROKER_ERROR_CLIENT_ACTIONS.noNormativeAction
}

function assertRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${name}`)
  return value as Record<string, unknown>
}

function assertHumanReadableMessage(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Invalid broker error message')
  }
}
