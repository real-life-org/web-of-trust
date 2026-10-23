// Preset dictionaries of the compact card link (card-link.ts). Raw deflate starts with the
// dictionary in its window, so the fixed parts of a card cost almost nothing: the key names in the
// order the lib writes them, `did:key:z6Mk`, the build mediator and the delivery hint template of the
// VTI profile (§1b), the proof constants. A card that differs (another card version, another
// mediator) still round-trips; it only compresses less.
//
// Frozen: a link names the version of its dictionary, and one changed byte makes every link of that
// version unreadable. A change is a new version (the next integer) with CARD_LINK_DICTIONARY_VERSION
// pointing to it; earlier versions stay here so that their links keep decoding. A test pins the
// SHA-256 of every published version.

const MEDIATOR = 'did:webvh:QmR5xGk8pkd3ymu7xpfkjr7XZmwDALA5ZJmgG7qcrD2mKA:webvh.storm.ws:mediator'
const HINT = `{\\"id\\":\\"did:key:z6Mk#tsp\\",\\"rltpEgress\\":\\"did:key:z6Mk\\",\\"serviceEndpoint\\":\\"${MEDIATOR}\\",\\"type\\":\\"TSPTransport\\"}`

/** version → dictionary text (UTF-8). Never edit a published entry. */
export const CARD_LINK_DICTIONARIES: Readonly<Record<string, string>> = Object.freeze({
  '1':
    `{"version":"rltp-card/0.25","anchor":"did:key:z6Mk","keyAgreement":"z6LS","name":"","deliveryHints":["${HINT}"],` +
    `"challenge":{"value":"","issuedAt":"20"},"sentTo":"did:key:z6Mk","boundTo":"",` +
    `"proof":{"type":"DataIntegrityProof","cryptosuite":"eddsa-jcs-2022","created":"20",` +
    `"verificationMethod":"did:key:z6Mk#z6Mk","proofPurpose":"assertionMethod","proofValue":"z`,
})

/** The version the encoder writes. */
export const CARD_LINK_DICTIONARY_VERSION = '1'
