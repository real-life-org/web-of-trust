import { ProtocolCryptoAdapter } from '../crypto/ports';
import { BrokerErrorCode } from './broker-error';
import { DeviceRevokePayload } from './device-revocation-disposition';
export declare const BROKER_DEVICE_REVOKE_CONTROL_FRAME_TYPE: "device-revoke";
export interface BrokerDeviceRevokeControlFrame {
    type: typeof BROKER_DEVICE_REVOKE_CONTROL_FRAME_TYPE;
    revocationJws: string;
}
export interface BrokerDeviceRevokeJwsHeader {
    alg: 'EdDSA';
    kid: string;
    typ?: string;
    [key: string]: unknown;
}
export interface ParsedBrokerDeviceRevokeControlFrame extends BrokerDeviceRevokeControlFrame {
    header: Record<string, unknown>;
    payload: DeviceRevokePayload;
    signingBytes: Uint8Array;
    signatureBytes: Uint8Array;
}
export interface CreateBrokerDeviceRevokeControlFrameOptions {
    revocationJws: string;
}
export interface VerifyBrokerDeviceRevokeControlFrameOptions {
    frame: unknown;
    publicKey: Uint8Array;
    crypto: Pick<ProtocolCryptoAdapter, 'verifyEd25519'>;
}
export type BrokerDeviceRevokeVerificationResult = {
    disposition: 'accepted';
    frame: BrokerDeviceRevokeControlFrame;
    header: Record<string, unknown>;
    payload: DeviceRevokePayload;
    signingBytes: Uint8Array;
    signatureBytes: Uint8Array;
} | {
    disposition: 'rejected';
    errorCode: Extract<BrokerErrorCode, 'MALFORMED_MESSAGE' | 'AUTH_INVALID'>;
};
/**
 * Creates the Sync 003 signed `device-revoke` Broker Control-Frame wire shape.
 * Spec refs:
 * - wot-spec Sync 003 `03-wot-sync/003-transport-und-broker.md#device-deaktivierung`
 * - wot-spec Sync 003 `03-wot-sync/003-transport-und-broker.md#broker-control-frames-normativ`
 * - wot-spec Sync 003 `03-wot-sync/003-transport-und-broker.md#authentizitaet-pro-message-typ-normativ`
 *
 * This helper is intentionally protocol-only: it parses the closed outer
 * frame, decodes the inner JWS payload, and exposes bytes for verification.
 * Broker storage mutation, DID resolution policy, routing, inbox cleanup, and
 * runtime error emission remain caller responsibilities.
 */
export declare function createBrokerDeviceRevokeControlFrame(options: CreateBrokerDeviceRevokeControlFrameOptions): BrokerDeviceRevokeControlFrame;
export declare function parseBrokerDeviceRevokeControlFrame(value: unknown): ParsedBrokerDeviceRevokeControlFrame;
export declare function assertBrokerDeviceRevokeControlFrame(value: unknown): asserts value is BrokerDeviceRevokeControlFrame;
export declare function verifyBrokerDeviceRevokeControlFrame(options: VerifyBrokerDeviceRevokeControlFrameOptions): Promise<BrokerDeviceRevokeVerificationResult>;
//# sourceMappingURL=broker-device-revoke-control-frame.d.ts.map