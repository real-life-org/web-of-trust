import {
  createPlaintextMessage,
  type DidcommPlaintextMessage,
} from '../../src/protocol/sync/membership-messages'
import { INBOX_MESSAGE_TYPE } from '../../src/protocol/messaging/inbox-message'

/**
 * DIDComm-Wire-Form der Inbox-Familie für Transport-Tests (VE-8).
 * Aus Transportsicht ist der Body ein opaker ECIES-Container
 * ({epk, nonce, ciphertext}, Base64URL) — Transport-Adapter routen über
 * to[0] und lesen den Body nie (Sync 003 Z.328-341).
 */
export function createDidcommTestMessage(options: {
  from: string
  to: string[]
  id?: string
  type?: string
}): DidcommPlaintextMessage {
  return createPlaintextMessage({
    id: options.id ?? crypto.randomUUID(),
    type: options.type ?? INBOX_MESSAGE_TYPE,
    from: options.from,
    to: options.to,
    createdTime: Math.floor(Date.now() / 1000),
    body: { epk: 'ZXBr', nonce: 'bm9uY2U', ciphertext: 'Y2lwaGVydGV4dC1taXQtbWluZGVzdGVucy0xNy1ieXRlcw' },
  })
}
