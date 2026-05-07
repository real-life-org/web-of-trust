import { ProtocolCryptoAdapter } from '../crypto/ports';
export type SpaceCapabilityPermission = 'read' | 'write';
export interface SpaceCapabilityPayload {
    type: 'capability';
    spaceId: string;
    audience: string;
    permissions: SpaceCapabilityPermission[];
    generation: number;
    issuedAt: string;
    validUntil: string;
}
export interface CreateSpaceCapabilityJwsOptions {
    payload: SpaceCapabilityPayload;
    signingSeed: Uint8Array;
}
export interface VerifySpaceCapabilityJwsOptions {
    crypto: ProtocolCryptoAdapter;
    publicKey: Uint8Array;
    expectedSpaceId?: string;
    expectedAudience?: string;
    expectedGeneration?: number;
    now?: Date;
}
export declare function createSpaceCapabilityJws(options: CreateSpaceCapabilityJwsOptions): Promise<string>;
export declare function verifySpaceCapabilityJws(jws: string, options: VerifySpaceCapabilityJwsOptions): Promise<SpaceCapabilityPayload>;
//# sourceMappingURL=space-capability.d.ts.map