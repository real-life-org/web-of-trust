/**
 * M2-Codec-Tests: Die documentUrl reist zusammen mit dem Doc-Snapshot im
 * Group-Key-verschlüsselten Blob (AES-GCM schützt die Integrität). Sync 005
 * Z.68-90 definiert den space-invite-Body abschließend (Schema
 * space-invite.schema.json: body additionalProperties false) — documentUrl
 * darf weder in den signierten Body noch als unauthentifizierte
 * Wire-Extension neben den ECIES-Container.
 */
import { describe, it, expect } from 'vitest'
import {
  SPACE_INVITE_SNAPSHOT_VERSION,
  decodeSpaceInviteSnapshotPayload,
  encodeSpaceInviteSnapshotPayload,
} from '../src/space-invite-snapshot'

const DOC_URL = 'automerge:4NMNnkMhL8jXrdJbL1DGqf6yjjg6'

describe('space-invite snapshot payload codec (M2)', () => {
  it('roundtrips documentUrl + docBinary', () => {
    const docBinary = new Uint8Array([1, 2, 3, 255, 0, 42])
    const encoded = encodeSpaceInviteSnapshotPayload({ documentUrl: DOC_URL, docBinary })
    const decoded = decodeSpaceInviteSnapshotPayload(encoded)
    expect(decoded.documentUrl).toBe(DOC_URL)
    expect(decoded.docBinary).toEqual(docBinary)
  })

  it('roundtrips an empty docBinary (Inhalt kommt via Live-Sync)', () => {
    const encoded = encodeSpaceInviteSnapshotPayload({ documentUrl: DOC_URL, docBinary: new Uint8Array(0) })
    const decoded = decodeSpaceInviteSnapshotPayload(encoded)
    expect(decoded.documentUrl).toBe(DOC_URL)
    expect(decoded.docBinary).toHaveLength(0)
  })

  it('rejects an empty documentUrl on encode', () => {
    expect(() =>
      encodeSpaceInviteSnapshotPayload({ documentUrl: '', docBinary: new Uint8Array([1]) }),
    ).toThrow('documentUrl')
  })

  it('rejects an unknown payload version', () => {
    const encoded = encodeSpaceInviteSnapshotPayload({ documentUrl: DOC_URL, docBinary: new Uint8Array([1]) })
    expect(encoded[0]).toBe(SPACE_INVITE_SNAPSHOT_VERSION)
    const wrongVersion = new Uint8Array(encoded)
    wrongVersion[0] = 99
    expect(() => decodeSpaceInviteSnapshotPayload(wrongVersion)).toThrow('version')
  })

  it('rejects truncated payloads (Header bzw. URL-Länge über Puffer-Ende)', () => {
    const encoded = encodeSpaceInviteSnapshotPayload({ documentUrl: DOC_URL, docBinary: new Uint8Array([1]) })
    expect(() => decodeSpaceInviteSnapshotPayload(encoded.slice(0, 3))).toThrow()
    // URL-Länge zeigt über das Puffer-Ende hinaus:
    const truncated = encoded.slice(0, 5 + 4)
    expect(() => decodeSpaceInviteSnapshotPayload(truncated)).toThrow()
  })
})
