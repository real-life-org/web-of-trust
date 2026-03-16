# Encrypted Blob Store

> Concept for encrypted binary data (profile pictures, attachments) in the Web of Trust

**Status:** Planned — not yet implemented
**Priority:** MVP phase

---

## Problem

Binary data (images, documents) must **not** end up in CRDT docs:

- Every mutation delta includes the binary data as a change
- Sync sends the entire doc snapshot including all blobs
- A PersonalDoc with 9 contacts and avatars already reaches 250KB
- A space with 10 profile pictures at 100KB each = 1MB per sync

At the same time, users want certain data (e.g. a profile picture) to remain private,
but still be shareable with trusted contacts.

## Three Visibility Levels

| Level | Example | Storage | Access |
| --- | --- | --- | --- |
| **Public** | Name, bio | wot-profiles (`GET /p/{did}`) | Anyone |
| **Contacts** | Profile picture, phone | Encrypted on IPFS | Whoever has the key |
| **Space** | Project files | Encrypted on IPFS (space key) | Space members |

## Storage: IPFS

Binary data is stored on IPFS rather than a custom blob service:

| Aspect | Why IPFS |
| --- | --- |
| **Content addressing** | CID = hash of content. Same file = same hash = stored once |
| **Deduplication** | Built-in — no extra logic needed |
| **Decentralization** | Fits the project philosophy — no single point of failure |
| **Portability** | Any IPFS node can host the data, not locked to our server |
| **Federation** | Community servers can pin shared blobs |
| **Client** | Standard `fetch()` to HTTP Gateway — zero bundle size overhead |

### Deployment

A self-hosted IPFS node (Kubo) runs alongside Relay, Vault, and Profiles:

```text
Server (utopia-lab.org)
├── wot-relay    (WebSocket, port 9090)
├── wot-vault    (HTTP, port 8789)
├── wot-profiles (HTTP, port 8790)
└── kubo         (IPFS, Gateway port 8080, API port 5001)
```

No IPFS client library is needed in the browser — just `fetch()`:

```text
Upload:   POST  http://ipfs.utopia-lab.org:5001/api/v0/add
Download: GET   http://ipfs.utopia-lab.org:8080/ipfs/{cid}
```

## Architecture

```text
User                            IPFS Node (Kubo)
----                            ----------------

Profile picture (plaintext)
    |
    v
AES-256-GCM encrypt
(with "contact blob key")
    |
    v
POST /api/v0/add  ---------->  Stores ciphertext, returns CID
                                (cannot read content)

Contact wants to see picture:
GET /ipfs/{cid}   <----------   Returns ciphertext
    |
    v
AES-256-GCM decrypt
(with contact blob key)
    |
    v
Profile picture (plaintext)
```

## Key Distribution

The blob key is shared **once** at contact time via ECIES:

```text
Anton verifies Bob
    |
    v
ECIES(blob-key, bob-encryption-pubkey) ---> Bob
    |
    Bob stores Anton's blob-key locally
    Bob can now read all of Anton's private blobs
```

### Advantages over a Messaging Approach

| Aspect | Messaging (worse) | Blob Store (better) |
| --- | --- | --- |
| Change picture | n messages to n contacts | 1 upload, contacts fetch themselves |
| New contact | Send again | Share key, contact fetches |
| Contact offline | Redelivery problem | Fetches when online |
| Cache cleared | Send again | Fetch again |
| Bandwidth | n × image size | 1 × image size + n × key size |

### Why not encrypt the image separately for each contact?

That would be O(n) encryption operations per blob upload. Instead:

- **1 symmetric key per visibility level** (e.g. "contacts key")
- Blob is encrypted once with this key
- The key is shared via ECIES to each contact (once, at contact time)
- Key rotation when a contact is removed (analogous to space group key rotation)

## Referencing

The CRDT doc stores only the CID reference:

```json
{
  "avatar": {
    "cid": "QmAbc123...",
    "scope": "contacts"
  }
}
```

The client resolves:

1. `cid` → `GET /ipfs/{cid}` from IPFS Gateway
2. `scope: "contacts"` → use local contact blob key
3. Decrypt + display

For public blobs (no encryption), the CID resolves directly to plaintext.

## Scope Keys

| Scope | Key | Shared with | Rotation |
| --- | --- | --- | --- |
| `contacts` | Contact blob key | All verified contacts | On contact removal |
| `space:{id}` | Space group key | Space members | On member removal (already implemented) |
| `public` | No key (plaintext) | Everyone | Never |

For spaces we can reuse the existing **GroupKeyService** —
the space group key then encrypts both CRDT changes and blobs.

## Priority

- **POC:** Not needed. Profile pictures public via wot-profiles or not at all.
- **MVP:** Move avatars out of PersonalDoc to IPFS. Implement contact blob key for private profile pictures.
- **Production:** Scope keys, space blobs, key rotation.

## Two Encryption Mechanisms — Intentionally Separate

The WoT uses two complementary encryption approaches:

| | Item-Keys | Contact Blob Key (Blob Store) |
| --- | --- | --- |
| **Data type** | Structured items (calendar, notes, attestations) | Binary data (profile pictures, thumbnails) |
| **Granularity** | Selectable per item (`contacts`, `selective`, `groups`) | Per scope (all contacts or space) |
| **Selective visibility** | Yes — item X only for Anna and Ben | No — all contacts or nobody |
| **Cost per item** | O(N) encryptions per item | O(1) per blob |
| **Key distribution** | Per item, per recipient | Once at contact time |

## Scope

This blob store is **not** a generic file storage system. It is optimized for:

- Small to medium blobs (profile pictures, thumbnails: < 1MB)
- Infrequent writes (changing a profile picture)
- Frequent reads (contact displays profile picture)

For large files (videos, documents) in spaces, IPFS chunking handles this naturally —
large files are split into blocks and reassembled on download.
