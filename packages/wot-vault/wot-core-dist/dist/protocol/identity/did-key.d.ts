import { DidDocument } from './did-document';
export declare function publicKeyToDidKey(publicKey: Uint8Array): string;
export declare function ed25519PublicKeyToMultibase(publicKey: Uint8Array): string;
export declare function x25519PublicKeyToMultibase(publicKey: Uint8Array): string;
export declare function didOrKidToDid(didOrKid: string): string;
export declare function didKeyToPublicKeyBytes(didOrKid: string): Uint8Array;
export interface ResolveDidKeyOptions {
    keyAgreement?: DidDocument['keyAgreement'];
    service?: NonNullable<DidDocument['service']>;
}
export declare function ed25519MultibaseToPublicKeyBytes(multibase: string): Uint8Array;
export declare function x25519MultibaseToPublicKeyBytes(multibase: string): Uint8Array;
export declare function resolveDidKey(did: string, options?: ResolveDidKeyOptions): DidDocument;
//# sourceMappingURL=did-key.d.ts.map