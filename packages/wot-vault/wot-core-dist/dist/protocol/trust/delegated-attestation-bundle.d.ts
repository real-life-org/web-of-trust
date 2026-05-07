import { ProtocolCryptoAdapter } from '../crypto/ports';
import { AttestationVcPayload } from './attestation-vc-jws';
import { DeviceCapability, DeviceKeyBindingPayload } from '../identity/device-key-binding';
import { JcsEd25519SignFn } from '../crypto/jws';
export interface DelegatedAttestationBundle {
    type: 'wot-delegated-attestation-bundle/v1';
    attestationJws: string;
    deviceKeyBindingJws: string;
}
export interface CreateDelegatedAttestationBundleOptions {
    attestationPayload: AttestationVcPayload;
    deviceKid: string;
    deviceSigningSeed: Uint8Array;
    deviceKeyBindingJws: string;
}
export interface CreateDelegatedAttestationBundleWithSignerOptions {
    attestationPayload: AttestationVcPayload;
    deviceKid: string;
    sign: JcsEd25519SignFn;
    deviceKeyBindingJws: string;
}
export interface VerifyDelegatedAttestationBundleOptions {
    crypto: ProtocolCryptoAdapter;
    requiredCapability?: DeviceCapability;
}
export declare function createDelegatedAttestationBundle(options: CreateDelegatedAttestationBundleOptions): Promise<DelegatedAttestationBundle>;
export declare function createDelegatedAttestationBundleWithSigner(options: CreateDelegatedAttestationBundleWithSignerOptions): Promise<DelegatedAttestationBundle>;
export declare function verifyDelegatedAttestationBundle(bundle: DelegatedAttestationBundle, options: VerifyDelegatedAttestationBundleOptions): Promise<{
    attestationPayload: Record<string, unknown>;
    bindingPayload: DeviceKeyBindingPayload;
}>;
//# sourceMappingURL=delegated-attestation-bundle.d.ts.map