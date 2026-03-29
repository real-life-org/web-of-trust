import { MessagingAdapter } from '../interfaces/MessagingAdapter';
import { MessageEnvelope, DeliveryReceipt, MessagingState } from '../../types/messaging';
/**
 * WebSocket-based messaging adapter that connects to a relay server.
 *
 * Uses the browser-native WebSocket API (no `ws` dependency needed).
 * The relay is blind — it only forwards envelopes without inspecting payloads.
 *
 * Protocol:
 * - Client sends: { type: 'register', did } | { type: 'send', envelope } | { type: 'ack', messageId }
 * - Relay sends:  { type: 'registered', did } | { type: 'message', envelope }
 *                 | { type: 'receipt', receipt } | { type: 'error', code, message }
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
    private heartbeatInterval;
    private heartbeatTimeout;
    private readonly HEARTBEAT_INTERVAL_MS;
    private readonly HEARTBEAT_TIMEOUT_MS;
    private readonly SEND_TIMEOUT_MS;
    constructor(relayUrl: string, options?: {
        sendTimeoutMs?: number;
    });
    private setState;
    onStateChange(callback: (state: MessagingState) => void): () => void;
    connect(myDid: string): Promise<void>;
    disconnect(): Promise<void>;
    getState(): MessagingState;
    private startHeartbeat;
    private stopHeartbeat;
    /**
     * Process incoming message: await all callbacks, then ACK.
     * Extracted from onmessage handler so callbacks can be async.
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