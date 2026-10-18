// Identifiers of the app port (architecture §2.2). The port never hands out DIDs, anchors or keys
// as display values; where a screen needs an identifier it gets a finished short form.

export type Brand<T, B extends string> = T & { readonly __brand: B }

/** Stable entry id of the core (survives aliases and chains). */
export type ContactId = Brand<string, 'ContactId'>
/** Genesis digest. */
export type GroupId = Brand<string, 'GroupId'>
export type MessageId = Brand<string, 'MessageId'>
export type DecisionId = Brand<string, 'DecisionId'>
/** Opaque reference to a group member. */
export type MemberRef = Brand<string, 'MemberRef'>
/** UUID v4, minted in the command service (architecture §3.4), never in a hook or screen. */
export type ActId = Brand<string, 'ActId'>
export type ConversationKey = `c:${string}` | `g:${string}`
