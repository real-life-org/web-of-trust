export declare const BROKER_REGISTER_CONTROL_FRAME_TYPE: "register";
export declare const BROKER_CHALLENGE_CONTROL_FRAME_TYPE: "challenge";
export declare const BROKER_REGISTERED_CONTROL_FRAME_TYPE: "registered";
export interface BrokerRegisterControlFrame {
    type: typeof BROKER_REGISTER_CONTROL_FRAME_TYPE;
    did: string;
    deviceId: string;
}
export interface BrokerChallengeControlFrame {
    type: typeof BROKER_CHALLENGE_CONTROL_FRAME_TYPE;
    nonce: string;
}
export interface ParsedBrokerChallengeControlFrame extends BrokerChallengeControlFrame {
    nonceBytes: Uint8Array;
}
export interface BrokerRegisteredControlFrame {
    type: typeof BROKER_REGISTERED_CONTROL_FRAME_TYPE;
    did: string;
    deviceId: string;
    isNewDevice: boolean;
}
export interface CreateBrokerRegisterControlFrameOptions {
    did: string;
    deviceId: string;
}
export interface CreateBrokerChallengeControlFrameOptions {
    nonce: Uint8Array;
}
export interface CreateBrokerRegisteredControlFrameOptions {
    did: string;
    deviceId: string;
    isNewDevice: boolean;
}
/**
 * Creates the Sync 003 `register` Broker Control-Frame wire shape.
 *
 * Spec: wot-spec 03-wot-sync/003-transport-und-broker.md,
 * sections `Authentisierung` and `Broker Control-Frames (NORMATIV)`.
 *
 * This helper is intentionally limited to deterministic frame validation. It
 * does not bind WebSocket state, persist devices, resolve DIDs, or verify
 * Challenge-Response signatures.
 */
export declare function createBrokerRegisterControlFrame(options: CreateBrokerRegisterControlFrameOptions): BrokerRegisterControlFrame;
export declare function parseBrokerRegisterControlFrame(value: unknown): BrokerRegisterControlFrame;
export declare function assertBrokerRegisterControlFrame(value: unknown): asserts value is BrokerRegisterControlFrame;
/**
 * Creates the Sync 003 `challenge` Broker Control-Frame wire shape from
 * caller-supplied nonce bytes. Randomness and issued-nonce storage remain
 * caller/runtime responsibilities.
 *
 * Spec: wot-spec 03-wot-sync/003-transport-und-broker.md,
 * sections `Authentisierung`, `Nonce-Handling (MUSS)`, and
 * `Broker Control-Frames (NORMATIV)`.
 */
export declare function createBrokerChallengeControlFrame(options: CreateBrokerChallengeControlFrameOptions): BrokerChallengeControlFrame;
export declare function parseBrokerChallengeControlFrame(value: unknown): ParsedBrokerChallengeControlFrame;
export declare function assertBrokerChallengeControlFrame(value: unknown): asserts value is BrokerChallengeControlFrame;
/**
 * Creates the Sync 003 `registered` Broker Control-Frame wire shape. Device
 * list persistence and inbox delivery after registration stay out of
 * protocol-core scope.
 *
 * Spec: wot-spec 03-wot-sync/003-transport-und-broker.md,
 * sections `Erstregistrierung`, `Erneute Verbindung eines bekannten Devices`,
 * and `Broker Control-Frames (NORMATIV)`.
 */
export declare function createBrokerRegisteredControlFrame(options: CreateBrokerRegisteredControlFrameOptions): BrokerRegisteredControlFrame;
export declare function parseBrokerRegisteredControlFrame(value: unknown): BrokerRegisteredControlFrame;
export declare function assertBrokerRegisteredControlFrame(value: unknown): asserts value is BrokerRegisteredControlFrame;
//# sourceMappingURL=broker-registration-control-frames.d.ts.map