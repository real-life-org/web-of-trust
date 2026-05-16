import { DidcommPlaintextMessage } from './membership-messages';
import { SyncHeads } from './heads';
export declare const SYNC_REQUEST_MESSAGE_TYPE: "https://web-of-trust.de/protocols/sync-request/1.0";
export declare const SYNC_RESPONSE_MESSAGE_TYPE: "https://web-of-trust.de/protocols/sync-response/1.0";
export type SyncMessageHeads = SyncHeads;
export interface SyncRequestBody {
    docId: string;
    heads: SyncHeads;
    limit?: number;
}
export interface SyncResponseBody {
    docId: string;
    entries: string[];
    heads: SyncHeads;
    truncated: boolean;
}
export type SyncRequestMessage = DidcommPlaintextMessage<SyncRequestBody, typeof SYNC_REQUEST_MESSAGE_TYPE> & {
    type: typeof SYNC_REQUEST_MESSAGE_TYPE;
};
export type SyncResponseMessage = DidcommPlaintextMessage<SyncResponseBody, typeof SYNC_RESPONSE_MESSAGE_TYPE> & {
    type: typeof SYNC_RESPONSE_MESSAGE_TYPE;
    thid: string;
};
export interface CreateSyncRequestMessageOptions {
    id: string;
    from: string;
    to?: string[];
    createdTime: number;
    body: SyncRequestBody;
    thid?: string;
    pthid?: string;
}
export interface CreateSyncResponseMessageOptions {
    id: string;
    from: string;
    to?: string[];
    createdTime: number;
    body: SyncResponseBody;
    thid: string;
    pthid?: string;
}
export declare function createSyncRequestMessage(options: CreateSyncRequestMessageOptions): SyncRequestMessage;
export declare function createSyncResponseMessage(options: CreateSyncResponseMessageOptions): SyncResponseMessage;
export declare function parseSyncRequestMessage(value: unknown): SyncRequestMessage;
export declare function parseSyncResponseMessage(value: unknown): SyncResponseMessage;
export declare function assertSyncRequestMessage(value: unknown): asserts value is SyncRequestMessage;
export declare function assertSyncResponseMessage(value: unknown): asserts value is SyncResponseMessage;
export declare function assertSyncRequestBody(value: unknown): asserts value is SyncRequestBody;
export declare function assertSyncResponseBody(value: unknown): asserts value is SyncResponseBody;
//# sourceMappingURL=sync-messages.d.ts.map