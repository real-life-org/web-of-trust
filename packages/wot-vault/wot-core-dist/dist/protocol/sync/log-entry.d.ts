import { ProtocolCryptoAdapter } from '../crypto/ports';
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
export declare function createLogEntryJws(options: CreateLogEntryJwsOptions): Promise<string>;
export declare function verifyLogEntryJws(jws: string, options: VerifyLogEntryJwsOptions): Promise<LogEntryPayload>;
//# sourceMappingURL=log-entry.d.ts.map