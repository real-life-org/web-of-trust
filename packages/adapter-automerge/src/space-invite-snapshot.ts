/**
 * Automerge-spezifische space-invite-Snapshot-Nutzlast (Review M2).
 *
 * Sync 005 Z.68-90 definiert den space-invite-Body abschließend (Schema
 * space-invite.schema.json: body `additionalProperties: false`) — die
 * documentUrl darf dort nicht hinein und DARF auch nicht als
 * unauthentifizierte Wire-Extension neben dem ECIES-Container reisen: ein
 * untrusted Broker (Threat-Model) könnte sie beim Store-and-Forward
 * austauschen und den Empfänger dauerhaft an eine attacker-kontrollierte
 * documentId binden (Split-Brain/DoS). Deshalb reist die documentUrl
 * zusammen mit dem Doc-Snapshot IM Group-Key-verschlüsselten OneShot-Blob:
 * AES-256-GCM schützt die Integrität, den Key liefert der Inner-JWS-signierte
 * Invite-Body (spaceContentKeys).
 *
 * Binärformat (Version 1):
 *   [0]      Version (u8)
 *   [1..4]   Länge der UTF-8-kodierten documentUrl (u32, big-endian)
 *   [5..n]   documentUrl (UTF-8)
 *   [n..]    Automerge-Doc-Binary (darf leer sein — Inhalt kommt via Sync)
 */

export const SPACE_INVITE_SNAPSHOT_VERSION = 1

const HEADER_LENGTH = 5

export interface SpaceInviteSnapshotPayload {
  /** automerge-repo Doc-URL des Senders — Routing-Metadatum, kein Key-Material. */
  documentUrl: string
  /** Automerge.save()-Snapshot des Space-Docs. */
  docBinary: Uint8Array
}

export function encodeSpaceInviteSnapshotPayload(payload: SpaceInviteSnapshotPayload): Uint8Array {
  if (payload.documentUrl.length === 0) throw new Error('Missing snapshot payload documentUrl')
  const urlBytes = new TextEncoder().encode(payload.documentUrl)
  const encoded = new Uint8Array(HEADER_LENGTH + urlBytes.length + payload.docBinary.length)
  const view = new DataView(encoded.buffer)
  view.setUint8(0, SPACE_INVITE_SNAPSHOT_VERSION)
  view.setUint32(1, urlBytes.length, false)
  encoded.set(urlBytes, HEADER_LENGTH)
  encoded.set(payload.docBinary, HEADER_LENGTH + urlBytes.length)
  return encoded
}

export function decodeSpaceInviteSnapshotPayload(data: Uint8Array): SpaceInviteSnapshotPayload {
  if (data.length < HEADER_LENGTH) throw new Error('Truncated space-invite snapshot payload')
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const version = view.getUint8(0)
  if (version !== SPACE_INVITE_SNAPSHOT_VERSION) {
    throw new Error(`Unsupported space-invite snapshot payload version: ${version}`)
  }
  const urlLength = view.getUint32(1, false)
  if (urlLength === 0) throw new Error('Missing snapshot payload documentUrl')
  if (HEADER_LENGTH + urlLength > data.length) {
    throw new Error('Truncated space-invite snapshot payload documentUrl')
  }
  const documentUrl = new TextDecoder().decode(data.slice(HEADER_LENGTH, HEADER_LENGTH + urlLength))
  const docBinary = data.slice(HEADER_LENGTH + urlLength)
  return { documentUrl, docBinary }
}
