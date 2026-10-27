// Preset dictionaries of the compact card link (card-link.ts). Raw deflate starts with the
// dictionary in its window, so the fixed parts of a card cost almost nothing: the key names in the
// order the lib writes them, `did:key:z6Mk`, the build mediator and the delivery hint template of the
// VTI profile (§1b), the proof constants. A card that differs (another card version, another
// mediator) still round-trips; it only compresses less.
//
// Frozen: a link names the version of its dictionary, and one changed byte makes every link of that
// version unreadable. A change is a new version (the next integer) with CARD_LINK_DICTIONARY_VERSION
// pointing to it; earlier versions stay here so that their links keep decoding. tests/rltp/card-link.test.ts
// pins the SHA-256 of each version in a table; a version without its entry there fails the test.

/** The text of a dictionary for the build mediator `mediator` and the hint form of its profile: versions
 *  1 and 2 hold the four-member hint of VTI 0.28 (with `rltpEgress`), version 3 the three-member hint of
 *  VTI 0.29 (§1b, RLTP-VTI-1210). */
function dictionary(mediator: string, egress: boolean): string {
  const hint = egress
    ? `{\\"id\\":\\"did:key:z6Mk#tsp\\",\\"rltpEgress\\":\\"did:key:z6Mk\\",\\"serviceEndpoint\\":\\"${mediator}\\",\\"type\\":\\"TSPTransport\\"}`
    : `{\\"id\\":\\"did:key:z6Mk#tsp\\",\\"serviceEndpoint\\":\\"${mediator}\\",\\"type\\":\\"TSPTransport\\"}`
  return (
    `{"version":"rltp-card/0.25","anchor":"did:key:z6Mk","keyAgreement":"z6LS","name":"","deliveryHints":["${hint}"],` +
    `"challenge":{"value":"","issuedAt":"20"},"sentTo":"did:key:z6Mk","boundTo":"",` +
    `"proof":{"type":"DataIntegrityProof","cryptosuite":"eddsa-jcs-2022","created":"20",` +
    `"verificationMethod":"did:key:z6Mk#z6Mk","proofPurpose":"assertionMethod","proofValue":"z`
  )
}

/** version → dictionary text (UTF-8). Never edit a published entry. */
export const CARD_LINK_DICTIONARIES: Readonly<Record<string, string>> = Object.freeze({
  // the storm.ws dev instance (mediator 0.44, TSP Rev 3)
  '1': dictionary('did:webvh:QmR5xGk8pkd3ymu7xpfkjr7XZmwDALA5ZJmgG7qcrD2mKA:webvh.storm.ws:mediator', true),
  // mediator.web-of-trust.de (TSP 1.0), hints of VTI 0.28
  '2': dictionary('did:webvh:QmUTUkdHgppiciLpqcxkTi6Pbc9VuZzWXvH4L2Dk2dY2WL:mediator.web-of-trust.de', true),
  // mediator.web-of-trust.de (TSP 1.0), hints of VTI 0.29: one wire identity, no `rltpEgress`
  '3': dictionary('did:webvh:QmUTUkdHgppiciLpqcxkTi6Pbc9VuZzWXvH4L2Dk2dY2WL:mediator.web-of-trust.de', false),
})

/** The version the encoder writes. */
export const CARD_LINK_DICTIONARY_VERSION = '3'
