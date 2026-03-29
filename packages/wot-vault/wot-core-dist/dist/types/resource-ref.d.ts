/**
 * ResourceRef: Standardized pointer format for WoT resources.
 *
 * Format: wot:<type>:<id>[/<sub-path>]
 *
 * Examples:
 *   wot:attestation:abc-123
 *   wot:verification:def-456
 *   wot:space:wg-kalender
 *   wot:space:wg-kalender/item/event-789
 *   wot:contact:did:key:z6Mk...
 */
export type ResourceType = 'attestation' | 'verification' | 'contact' | 'space' | 'item';
declare const __brand: unique symbol;
export type ResourceRef = string & {
    readonly [__brand]: 'ResourceRef';
};
export declare function createResourceRef(type: ResourceType, id: string, subPath?: string): ResourceRef;
export declare function parseResourceRef(ref: ResourceRef): {
    type: ResourceType;
    id: string;
    subPath?: string;
};
export {};
//# sourceMappingURL=resource-ref.d.ts.map