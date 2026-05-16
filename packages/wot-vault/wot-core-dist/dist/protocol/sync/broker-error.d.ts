export declare const KNOWN_BROKER_ERROR_CODES: readonly ["DOC_NOT_FOUND", "CAPABILITY_INVALID", "CAPABILITY_EXPIRED", "CAPABILITY_GENERATION_STALE", "DEVICE_NOT_REGISTERED", "DEVICE_REVOKED", "DEVICE_ID_CONFLICT", "SEQ_COLLISION_DETECTED", "MALFORMED_MESSAGE", "AUTH_INVALID", "NONCE_REPLAY", "RATE_LIMITED", "INTERNAL_ERROR"];
export type BrokerErrorCode = (typeof KNOWN_BROKER_ERROR_CODES)[number];
export interface BrokerErrorBody {
    code: BrokerErrorCode;
    message: string;
    [key: string]: unknown;
}
export declare const BROKER_ERROR_CLIENT_ACTIONS: {
    readonly restoreCloneRecovery: "restore-clone-recovery";
    readonly requestFreshCapabilityViaPeerContact: "request-fresh-capability-via-peer-contact";
    readonly noNormativeAction: "no-normative-action";
};
export type BrokerErrorClientAction = (typeof BROKER_ERROR_CLIENT_ACTIONS)[keyof typeof BROKER_ERROR_CLIENT_ACTIONS];
export declare function isKnownBrokerErrorCode(value: unknown): value is BrokerErrorCode;
export declare function assertKnownBrokerErrorCode(value: unknown): asserts value is BrokerErrorCode;
export declare function parseBrokerErrorBody(value: unknown): BrokerErrorBody;
export declare function classifyBrokerErrorClientAction(code: unknown): BrokerErrorClientAction;
//# sourceMappingURL=broker-error.d.ts.map