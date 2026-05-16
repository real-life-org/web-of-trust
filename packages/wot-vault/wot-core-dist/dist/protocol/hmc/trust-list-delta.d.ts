import { DidcommPlaintextMessage } from '../sync/membership-messages';
export declare const TRUST_LIST_DELTA_MESSAGE_TYPE: "https://web-of-trust.de/protocols/trust-list-delta/1.0";
export interface TrustListDeltaBody {
    delta: string;
}
export type TrustListDeltaMessage = DidcommPlaintextMessage<TrustListDeltaBody, typeof TRUST_LIST_DELTA_MESSAGE_TYPE> & {
    type: typeof TRUST_LIST_DELTA_MESSAGE_TYPE;
    to: string[];
};
export interface CreateTrustListDeltaMessageOptions {
    id: string;
    from: string;
    to: string[];
    createdTime: number;
    delta: string;
    thid?: string;
    pthid?: string;
}
export declare function createTrustListDeltaMessage(options: CreateTrustListDeltaMessageOptions): TrustListDeltaMessage;
export declare function parseTrustListDeltaMessage(value: unknown): TrustListDeltaMessage;
export declare function assertTrustListDeltaMessage(value: unknown): asserts value is TrustListDeltaMessage;
export declare function assertTrustListDeltaBody(value: unknown): asserts value is TrustListDeltaBody;
//# sourceMappingURL=trust-list-delta.d.ts.map