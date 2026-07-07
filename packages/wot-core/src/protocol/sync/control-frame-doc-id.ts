import type { ControlFrame } from './control-frame-transport'
import {
  PRESENT_CAPABILITY_CONTROL_FRAME_TYPE,
  parsePresentCapabilityControlFrame,
} from './present-capability-control-frame'
import {
  SPACE_REGISTER_MESSAGE_TYPE,
  SPACE_ROTATE_MESSAGE_TYPE,
  parseSpaceRegisterMessage,
  parseSpaceRotateMessage,
} from './broker-admin-messages'

/**
 * Extract the docId (= spaceId) a control frame targets, or undefined.
 *
 * The relay correlates control-frame receipts by `messageId == docId`, so a
 * caller serializing control frames per (socket, docId) needs this to key the
 * pending-receipt waiter. `present-capability` carries the docId inside its
 * capability JWS payload; `space-register` / `space-rotate` inside their inner
 * JWS payload. `device-revoke` is not docId-scoped (returns undefined).
 */
export function controlFrameDocId(frame: ControlFrame): string | undefined {
  try {
    switch (frame.type) {
      case PRESENT_CAPABILITY_CONTROL_FRAME_TYPE: {
        const parsed = parsePresentCapabilityControlFrame(frame)
        return typeof parsed.payload.spaceId === 'string' ? parsed.payload.spaceId : undefined
      }
      case SPACE_REGISTER_MESSAGE_TYPE:
        return parseSpaceRegisterMessage(frame).payload.spaceId
      case SPACE_ROTATE_MESSAGE_TYPE:
        return parseSpaceRotateMessage(frame).payload.spaceId
      default:
        return undefined
    }
  } catch {
    return undefined
  }
}
