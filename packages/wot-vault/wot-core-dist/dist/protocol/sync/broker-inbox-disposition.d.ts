export type BrokerInboxDeviceStatus = 'active' | 'revoked';
export interface BrokerInboxAuthenticatedDevice {
    did: string;
    deviceId: string;
}
export interface BrokerInboxDevice extends BrokerInboxAuthenticatedDevice {
    status: BrokerInboxDeviceStatus;
}
export interface BrokerInboxEntry extends BrokerInboxAuthenticatedDevice {
    messageId: string;
    acked: boolean;
}
export type BrokerInboxCleanupReason = 'device-revoked';
export interface BrokerInboxCleanupGuidance extends BrokerInboxAuthenticatedDevice {
    reason: BrokerInboxCleanupReason;
}
export interface BrokerInboxExcludedSenderTarget extends BrokerInboxAuthenticatedDevice {
    reason: 'self-addressed-sender-excluded';
}
export interface ComputeBrokerInboxDeliveryTargetsInput {
    messageId: string;
    sender: BrokerInboxAuthenticatedDevice;
    recipientDid: string;
    recipientDevices: readonly BrokerInboxDevice[];
}
export interface BrokerInboxDeliveryDisposition {
    deliveryTargets: BrokerInboxEntry[];
    cleanupPendingEntriesFor: BrokerInboxCleanupGuidance[];
    excludedSenderTarget?: BrokerInboxExcludedSenderTarget;
    fullyDelivered: boolean;
}
export interface ApplyBrokerInboxAckInput {
    authenticatedDevice: BrokerInboxAuthenticatedDevice;
    messageId: string;
    entries: readonly BrokerInboxEntry[];
}
export interface BrokerInboxAckDisposition {
    ackApplied: boolean;
    entries: BrokerInboxEntry[];
    fullyDelivered: boolean;
}
export declare function computeBrokerInboxDeliveryTargets(input: ComputeBrokerInboxDeliveryTargetsInput): BrokerInboxDeliveryDisposition;
export declare function applyBrokerInboxAck(input: ApplyBrokerInboxAckInput): BrokerInboxAckDisposition;
//# sourceMappingURL=broker-inbox-disposition.d.ts.map