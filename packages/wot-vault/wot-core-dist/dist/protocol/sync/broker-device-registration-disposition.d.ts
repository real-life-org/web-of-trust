export type BrokerDeviceRegistrationDeviceStatus = 'active' | 'revoked';
export type BrokerDeviceRegistrationErrorCode = 'DEVICE_ID_CONFLICT' | 'DEVICE_REVOKED';
export type BrokerDeviceRegistrationAction = BrokerDeviceRegistrationPersistActiveDeviceAction | BrokerDeviceRegistrationDeliverPendingInboxMessagesAction;
export interface BrokerDeviceRegistrationDeviceRecord {
    did: string;
    deviceId: string;
    status: BrokerDeviceRegistrationDeviceStatus;
}
export interface BrokerDeviceRegistrationDispositionInput {
    did: string;
    deviceId: string;
    deviceList: readonly BrokerDeviceRegistrationDeviceRecord[];
    revocationWins?: boolean;
}
export interface BrokerDeviceRegistrationPersistActiveDeviceAction {
    type: 'persist-active-device-registration';
    did: string;
    deviceId: string;
}
export interface BrokerDeviceRegistrationDeliverPendingInboxMessagesAction {
    type: 'deliver-pending-inbox-messages';
    did: string;
    deviceId: string;
}
export interface BrokerDeviceRegistrationRegisteredDisposition {
    disposition: 'registered';
    did: string;
    deviceId: string;
    isNewDevice: boolean;
    actions: readonly BrokerDeviceRegistrationAction[];
}
export interface BrokerDeviceRegistrationRejectedDisposition {
    disposition: 'rejected';
    did: string;
    deviceId: string;
    errorCode: BrokerDeviceRegistrationErrorCode;
    actions: readonly [];
}
export type BrokerDeviceRegistrationDisposition = BrokerDeviceRegistrationRegisteredDisposition | BrokerDeviceRegistrationRejectedDisposition;
/**
 * Sync 003 "Device-Registrierung" and "Race Conditions":
 * post-authenticated registration disposition for accepted `(did, deviceId)` inputs.
 */
export declare function evaluateBrokerDeviceRegistrationDisposition(input: BrokerDeviceRegistrationDispositionInput): BrokerDeviceRegistrationDisposition;
//# sourceMappingURL=broker-device-registration-disposition.d.ts.map