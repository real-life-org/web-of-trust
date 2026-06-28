import { decodeJws, type DecodedJws } from '../crypto/jws'

/**
 * Sync 003 `present-capability` Broker Control-Frame (VE-9, wot-sync@0.1).
 *
 * Spec refs:
 * - wot-spec Sync 003 `03-wot-sync/003-transport-und-broker.md#capability-präsentation-present-capability`
 * - wot-spec Sync 003 `03-wot-sync/003-transport-und-broker.md#broker-control-frames-normativ`
 *
 * Like `device-revoke` / `space-register` / `space-rotate`, this is a CLOSED
 * top-level control frame `{ type:'present-capability', capabilityJws }` — it is
 * NOT wrapped in a `send` envelope. The carried `capabilityJws` is either a
 * Space-Capability JWS (`kid = wot:space:<spaceId>#cap-<generation>`, verified
 * against the registered `spaceCapabilityVerificationKey`) or a self-issued
 * Personal-Doc-Capability JWS (`kid = <did>#<vm>`, self-issued under the
 * Identity-Key). The relay correlates the success receipt by
 * `messageId == spaceId(=docId)`; because that id is NOT unique across the
 * control-frame families (space-register/space-rotate/present-capability all
 * share it), the client MUST drive control frames per `(socket, docId)` strictly
 * sequentially (the LogSyncCoordinator owns that serialization).
 *
 * This helper is intentionally protocol-only: it parses the closed outer frame
 * and decodes the inner capability JWS payload for routing/verification. The
 * capability verification itself (Space vs Personal-Doc semantics) and runtime
 * receipt/error emission stay with the broker / coordinator.
 */

export const PRESENT_CAPABILITY_CONTROL_FRAME_TYPE = 'present-capability' as const

export interface PresentCapabilityControlFrame {
  type: typeof PRESENT_CAPABILITY_CONTROL_FRAME_TYPE
  capabilityJws: string
}

export interface ParsedPresentCapabilityControlFrame extends PresentCapabilityControlFrame {
  header: Record<string, unknown>
  payload: Record<string, unknown>
}

export interface CreatePresentCapabilityControlFrameOptions {
  capabilityJws: string
}

export function createPresentCapabilityControlFrame(
  options: CreatePresentCapabilityControlFrameOptions,
): PresentCapabilityControlFrame {
  const parsed = parsePresentCapabilityControlFrame({
    type: PRESENT_CAPABILITY_CONTROL_FRAME_TYPE,
    capabilityJws: options.capabilityJws,
  })
  return { type: parsed.type, capabilityJws: parsed.capabilityJws }
}

export function parsePresentCapabilityControlFrame(
  value: unknown,
): ParsedPresentCapabilityControlFrame {
  const frame = assertRecord(value, 'present-capability control-frame')
  assertTopLevelKeys(frame)
  assertRequiredOwnProperty(frame, 'type')
  assertRequiredOwnProperty(frame, 'capabilityJws')
  if (frame.type !== PRESENT_CAPABILITY_CONTROL_FRAME_TYPE) {
    throw new Error('Invalid present-capability control-frame type')
  }
  if (typeof frame.capabilityJws !== 'string' || !isCompactJws(frame.capabilityJws)) {
    throw new Error('Invalid present-capability capabilityJws')
  }
  const decoded = decodeInnerJws(frame.capabilityJws)
  return {
    type: PRESENT_CAPABILITY_CONTROL_FRAME_TYPE,
    capabilityJws: frame.capabilityJws,
    header: decoded.header,
    payload: decoded.payload,
  }
}

export function assertPresentCapabilityControlFrame(
  value: unknown,
): asserts value is PresentCapabilityControlFrame {
  parsePresentCapabilityControlFrame(value)
}

function decodeInnerJws(
  jws: string,
): DecodedJws<Record<string, unknown>, Record<string, unknown>> {
  let decoded: DecodedJws<Record<string, unknown>, Record<string, unknown>>
  try {
    decoded = decodeJws<Record<string, unknown>, Record<string, unknown>>(jws)
  } catch {
    throw new Error('Invalid present-capability capabilityJws')
  }
  if (typeof decoded.header !== 'object' || decoded.header === null) {
    throw new Error('Invalid present-capability capabilityJws')
  }
  return decoded
}

function assertRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${name}`)
  return value as Record<string, unknown>
}

function assertTopLevelKeys(frame: Record<string, unknown>): void {
  const allowed = new Set(['type', 'capabilityJws'])
  for (const key of Reflect.ownKeys(frame)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`Invalid present-capability control-frame property: ${String(key)}`)
    }
  }
}

function assertRequiredOwnProperty(
  frame: Record<string, unknown>,
  key: 'type' | 'capabilityJws',
): void {
  if (!Object.prototype.hasOwnProperty.call(frame, key)) {
    throw new Error(`Invalid present-capability control-frame ${key}`)
  }
}

function isCompactJws(value: string): boolean {
  const parts = value.split('.')
  return parts.length === 3 && parts.every((part) => part.length > 0)
}
