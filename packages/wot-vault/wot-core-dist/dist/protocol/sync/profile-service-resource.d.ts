import { ProtocolCryptoAdapter } from '../crypto/ports';
import { DidDocument, DidResolver } from '../identity/did-document';
export interface ProfileServiceResourcePayload {
    did: string;
    version: number;
    didDocument: DidDocument;
    profile: {
        name: string;
        [key: string]: unknown;
    };
    updatedAt: string;
}
export type ProfileServiceListResourceKind = 'verifications' | 'attestations';
export type ProfileServiceResourceKind = 'profile' | ProfileServiceListResourceKind;
export type ProfileServiceListResourcePayload = {
    did: string;
    version: number;
    verifications: string[];
    attestations?: never;
    updatedAt: string;
} | {
    did: string;
    version: number;
    verifications?: never;
    attestations: string[];
    updatedAt: string;
};
export type ProfileServiceAnyResourcePayload = ProfileServiceResourcePayload | ProfileServiceListResourcePayload;
export interface ValidateProfileServiceResourcePayloadOptions {
    expectedDid: string;
}
export interface ValidateProfileServiceListResourcePayloadOptions extends ValidateProfileServiceResourcePayloadOptions {
    resourceKind: ProfileServiceListResourceKind;
}
export interface VerifyProfileServiceResourceJwsOptions extends ValidateProfileServiceResourcePayloadOptions {
    resourceKind?: ProfileServiceResourceKind;
    didResolver: DidResolver;
    crypto: ProtocolCryptoAdapter;
}
export interface ProfileResourcePutAcceptanceOptions {
    incomingVersion: number;
    storedVersion?: number;
}
export type ProfileResourcePutAcceptance = {
    accept: true;
} | {
    accept: false;
    conflictVersion: number;
};
export interface ProfileResourceRollbackOptions {
    fetchedVersion: number;
    lastSeenVersion?: number;
}
export declare function validateProfileServiceResourcePayload(payload: unknown, options: ValidateProfileServiceResourcePayloadOptions): ProfileServiceResourcePayload;
export declare function validateProfileServiceListResourcePayload(payload: unknown, options: ValidateProfileServiceListResourcePayloadOptions): ProfileServiceListResourcePayload;
export declare function decideProfileResourcePutAcceptance(options: ProfileResourcePutAcceptanceOptions): ProfileResourcePutAcceptance;
export declare function detectProfileResourceRollback(options: ProfileResourceRollbackOptions): boolean;
export declare function verifyProfileServiceResourceJws(jws: string, options: VerifyProfileServiceResourceJwsOptions & {
    resourceKind: ProfileServiceListResourceKind;
}): Promise<ProfileServiceListResourcePayload>;
export declare function verifyProfileServiceResourceJws(jws: string, options: VerifyProfileServiceResourceJwsOptions & {
    resourceKind?: 'profile';
}): Promise<ProfileServiceResourcePayload>;
export declare function verifyProfileServiceResourceJws(jws: string, options: VerifyProfileServiceResourceJwsOptions): Promise<ProfileServiceAnyResourcePayload>;
//# sourceMappingURL=profile-service-resource.d.ts.map