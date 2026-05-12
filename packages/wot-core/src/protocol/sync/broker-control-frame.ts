import { parseBrokerErrorBody, type BrokerErrorBody } from './broker-error'

// Sync 003 broker control-frame helper for `error/1.0`.
// Normative context: real-life-org/wot-spec#36.
export const ERROR_CONTROL_FRAME_TYPE = 'error/1.0' as const

export interface BrokerErrorControlFrame {
  type: typeof ERROR_CONTROL_FRAME_TYPE
  thid: string | null
  body: BrokerErrorBody
}

export interface CreateBrokerErrorControlFrameOptions {
  thid: string | null
  body: BrokerErrorBody
}

export function createBrokerErrorControlFrame(
  options: CreateBrokerErrorControlFrameOptions,
): BrokerErrorControlFrame {
  return parseBrokerErrorControlFrame({
    type: ERROR_CONTROL_FRAME_TYPE,
    thid: options.thid,
    body: options.body,
  })
}

export function parseBrokerErrorControlFrame(value: unknown): BrokerErrorControlFrame {
  const frame = assertRecord(value, 'broker error control-frame')
  assertBrokerErrorControlFrameTopLevelKeys(frame)
  assertRequiredOwnProperty(frame, 'type')
  assertRequiredOwnProperty(frame, 'body')
  assertErrorControlFrameType(frame.type)
  const thid = parseBrokerErrorControlFrameThreadId(frame)
  const body = parseBrokerErrorBody(frame.body)

  return {
    type: ERROR_CONTROL_FRAME_TYPE,
    thid,
    body,
  }
}

export function assertBrokerErrorControlFrame(
  value: unknown,
): asserts value is BrokerErrorControlFrame {
  parseBrokerErrorControlFrame(value)
}

function assertRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${name}`)
  return value as Record<string, unknown>
}

function assertBrokerErrorControlFrameTopLevelKeys(frame: Record<string, unknown>): void {
  const allowedKeys = new Set(['type', 'thid', 'body'])
  for (const key of Object.keys(frame)) {
    if (!allowedKeys.has(key)) throw new Error(`Invalid broker error control-frame property: ${key}`)
  }
}

function assertErrorControlFrameType(value: unknown): asserts value is typeof ERROR_CONTROL_FRAME_TYPE {
  if (value !== ERROR_CONTROL_FRAME_TYPE) throw new Error('Invalid broker error control-frame type')
}

function assertRequiredOwnProperty(
  frame: Record<string, unknown>,
  key: 'type' | 'body',
): void {
  if (!Object.prototype.hasOwnProperty.call(frame, key)) {
    throw new Error(`Invalid broker error control-frame ${key}`)
  }
}

function parseBrokerErrorControlFrameThreadId(frame: Record<string, unknown>): string | null {
  if (!Object.prototype.hasOwnProperty.call(frame, 'thid')) {
    throw new Error('Invalid broker error control-frame thid')
  }
  const { thid } = frame
  if (thid === null) return null
  if (typeof thid !== 'string' || thid.length === 0) {
    throw new Error('Invalid broker error control-frame thid')
  }
  return thid
}
