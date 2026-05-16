/**
 * Sync 003 broker/device-revoke (post-signature disposition).
 * Spec refs:
 * - wot-spec/03-wot-sync/003-transport-und-broker.md#device-deaktivierung
 * - wot-spec/03-wot-sync/003-transport-und-broker.md#device-liste-im-broker
 * - wot-spec/03-wot-sync/003-transport-und-broker.md#race-conditions
 */
export type BrokerDeviceStatus = 'active' | 'revoked';
export type DeviceRevocationErrorCode = 'DEVICE_ID_CONFLICT' | 'MALFORMED_MESSAGE';
export interface DeviceRevokePayload {
    type: 'device-revoke';
    did: string;
    deviceId: string;
    revokedAt: string;
}
export interface DeviceRevocationDeviceRecord {
    did: string;
    deviceId: string;
    status: BrokerDeviceStatus;
    revokedAt?: string;
}
export type DeviceRevocationAction = {
    type: 'mark-device-revoked';
    did: string;
    deviceId: string;
    revokedAt: string;
} | {
    type: 'delete-pending-inbox-messages';
    did: string;
    deviceId: string;
} | {
    type: 'persist-revoked-device-tombstone';
    did: string;
    deviceId: string;
    revokedAt: string;
};
export type DeviceRevocationDisposition = {
    disposition: 'accepted';
    did: string;
    deviceId: string;
    revokedAt: string;
    actions: DeviceRevocationAction[];
} | {
    disposition: 'accepted-idempotent';
    did: string;
    deviceId: string;
    revokedAt: string;
    actions: DeviceRevocationAction[];
} | {
    disposition: 'accepted-tombstone';
    did: string;
    deviceId: string;
    revokedAt: string;
    actions: DeviceRevocationAction[];
} | {
    disposition: 'rejected';
    did?: string;
    deviceId?: string;
    errorCode: DeviceRevocationErrorCode;
    actions: [];
} | {
    disposition: 'not-for-known-device';
    did: string;
    deviceId: string;
    actions: [];
};
export type DeviceRevokePayloadValidation = {
    valid: true;
    payload: DeviceRevokePayload;
} | {
    valid: false;
    errorCode: 'MALFORMED_MESSAGE';
};
export interface DeviceRevocationDispositionInput {
    decodedPayload: unknown;
    deviceList: readonly DeviceRevocationDeviceRecord[];
}
export interface ClassifyDeviceRevocationDispositionInput {
    revocation: DeviceRevokePayload;
    knownDevice: DeviceRevocationDeviceRecord;
}
export type DeviceRevokeSignal = DeviceRevokePayload;
export type KnownBrokerDeviceRecord = DeviceRevocationDeviceRecord;
export declare function validateDeviceRevokePayload(payload: unknown): DeviceRevokePayloadValidation;
export declare function evaluateDeviceRevocationDisposition(input: DeviceRevocationDispositionInput): DeviceRevocationDisposition;
/**
 * Legacy narrow wrapper for callers that already selected one exact known
 * broker device record. It mirrors the Sync 003 idempotency rule used by
 * `evaluateDeviceRevocationDisposition`: duplicate revocations preserve the
 * first stored `revokedAt` and do not require another inbox cleanup action.
 */
export declare function classifyDeviceRevocationDisposition(input: ClassifyDeviceRevocationDispositionInput): DeviceRevocationDisposition;
//# sourceMappingURL=device-revocation-disposition.d.ts.map