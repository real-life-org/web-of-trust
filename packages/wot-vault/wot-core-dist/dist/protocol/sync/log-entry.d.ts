import { ProtocolCryptoAdapter } from '../crypto/ports';
import { DidcommPlaintextMessage } from './membership-messages';
export interface LogEntryPayload {
    seq: number;
    deviceId: string;
    docId: string;
    authorKid: string;
    keyGeneration: number;
    data: string;
    timestamp: string;
}
export interface CreateLogEntryJwsOptions {
    payload: LogEntryPayload;
    signingSeed: Uint8Array;
}
export interface VerifyLogEntryJwsOptions {
    crypto: ProtocolCryptoAdapter;
}
export declare const LOG_ENTRY_MESSAGE_TYPE: "https://web-of-trust.de/protocols/log-entry/1.0";
export interface LogEntryMessageBody {
    entry: string;
}
export type LogEntryMessage = DidcommPlaintextMessage<LogEntryMessageBody, typeof LOG_ENTRY_MESSAGE_TYPE> & {
    type: typeof LOG_ENTRY_MESSAGE_TYPE;
    to: string[];
};
export interface CreateLogEntryMessageOptions {
    id: string;
    from: string;
    to: string[];
    createdTime: number;
    entry: string;
    thid?: string;
    pthid?: string;
}
export declare function createLogEntryJws(options: CreateLogEntryJwsOptions): Promise<string>;
export declare function verifyLogEntryJws(jws: string, options: VerifyLogEntryJwsOptions): Promise<LogEntryPayload>;
export declare function createLogEntryMessage(options: CreateLogEntryMessageOptions): LogEntryMessage;
export declare function parseLogEntryMessage(value: unknown): LogEntryMessage;
export declare function assertLogEntryMessage(value: unknown): asserts value is LogEntryMessage;
export declare function assertLogEntryMessageBody(value: unknown): asserts value is LogEntryMessageBody;
export declare function assertLogEntryPayload(payload: unknown): asserts payload is LogEntryPayload;
//# sourceMappingURL=log-entry.d.ts.map