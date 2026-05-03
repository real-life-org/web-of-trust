import { MessagingAdapter } from '../../ports/MessagingAdapter';
import { MessageEnvelope, DeliveryReceipt, MessagingState } from '../../types/messaging';
/**
 * Function that signs a challenge nonce to prove DID ownership.
 * Returns base64url-encoded Ed25519 signature.
 */
export type SignChallengeFn = (nonce: string) => Promise<string>;
/**
 * WebSocket-based messaging adapter that connects to a relay server.
 *
 * Uses the browser-native WebSocket API (no `ws` dependency needed).
 * The relay is blind — it only forwards envelopes without inspecting payloads.
 *
 * Protocol (with challenge-response auth):
 * 1. Client → { type: 'register', did }
 * 2. Relay  → { type: 'challenge', nonce }
 * 3. Client → { type: 'challenge-response', did, nonce, signature }
 * 4. Relay  → { type: 'registered', did, peers }
 */
export declare class WebSocketMessagingAdapter implements MessagingAdapter {
    private relayUrl;
    private ws;
    private state;
    private messageCallbacks;
    private receiptCallbacks;
    private stateCallbacks;
    private transportMap;
    private pendingReceipts;
    /** Buffer for messages that arrive before any onMessage handler is registered */
    private earlyMessageBuffer;
    private heartbeatInterval;
    private heartbeatTimeout;
    private readonly HEARTBEAT_INTERVAL_MS;
    private readonly HEARTBEAT_TIMEOUT_MS;
    private readonly SEND_TIMEOUT_MS;
    private signChallenge;
    constructor(relayUrl: string, options?: {
        sendTimeoutMs?: number;
        signChallenge?: SignChallengeFn;
    });
    private setState;
    onStateChange(callback: (state: MessagingState) => void): () => void;
    private connectedDid;
    private peerCount;
    connect(myDid: string): Promise<void>;
    disconnect(): Promise<void>;
    getState(): MessagingState;
    getPeerCount(): number;
    private startHeartbeat;
    private stopHeartbeat;
    /**
     * Process incoming message: await all callbacks, then ACK.
     * If no handlers are registered yet, buffer the message for later delivery.
     */
    private handleIncomingMessage;
    private handlePong;
    send(envelope: MessageEnvelope): Promise<DeliveryReceipt>;
    onMessage(callback: (envelope: MessageEnvelope) => void | Promise<void>): () => void;
    onReceipt(callback: (receipt: DeliveryReceipt) => void): () => void;
    registerTransport(did: string, transportAddress: string): Promise<void>;
    resolveTransport(did: string): Promise<string | null>;
}
//# sourceMappingURL=WebSocketMessagingAdapter.d.ts.map