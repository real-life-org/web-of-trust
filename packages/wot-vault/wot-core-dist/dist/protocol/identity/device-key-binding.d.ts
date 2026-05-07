import { ProtocolCryptoAdapter } from '../crypto/ports';
import { JcsEd25519SignFn } from '../crypto/jws';
export type DeviceCapability = 'sign-log-entry' | 'sign-verification' | 'sign-attestation' | 'broker-auth' | 'device-admin';
export interface DeviceKeyBindingPayload {
    type: 'device-key-binding';
    iss: string;
    sub: string;
    deviceKid: string;
    devicePublicKeyMultibase: string;
    deviceName?: string;
    capabilities: DeviceCapability[];
    validFrom: string;
    validUntil: string;
    iat: number;
}
export interface CreateDeviceKeyBindingJwsOptions {
    payload: DeviceKeyBindingPayload;
    issuerKid: string;
    signingSeed: Uint8Array;
}
export interface CreateDeviceKeyBindingJwsWithSignerOptions {
    payload: DeviceKeyBindingPayload;
    issuerKid: string;
    sign: JcsEd25519SignFn;
}
export interface VerifyDeviceKeyBindingJwsOptions {
    crypto: ProtocolCryptoAdapter;
}
export declare function createDeviceKeyBindingJws(options: CreateDeviceKeyBindingJwsOptions): Promise<string>;
export declare function createDeviceKeyBindingJwsWithSigner(options: CreateDeviceKeyBindingJwsWithSignerOptions): Promise<string>;
export declare function verifyDeviceKeyBindingJws(jws: string, options: VerifyDeviceKeyBindingJwsOptions): Promise<DeviceKeyBindingPayload>;
//# sourceMappingURL=device-key-binding.d.ts.map