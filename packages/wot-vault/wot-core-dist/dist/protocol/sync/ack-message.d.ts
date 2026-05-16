import { DidcommPlaintextMessage } from './membership-messages';
export declare const ACK_MESSAGE_TYPE: "https://web-of-trust.de/protocols/ack/1.0";
export interface AckMessageBody {
    messageId: string;
}
export type AckMessage = DidcommPlaintextMessage<AckMessageBody, typeof ACK_MESSAGE_TYPE> & {
    type: typeof ACK_MESSAGE_TYPE;
    thid: string;
};
export interface CreateAckMessageOptions {
    id: string;
    from: string;
    to?: string[];
    createdTime: number;
    thid: string;
    pthid?: string;
    body: AckMessageBody;
}
export declare function createAckMessage(options: CreateAckMessageOptions): AckMessage;
export declare function parseAckMessage(value: unknown): AckMessage;
export declare function assertAckMessage(value: unknown): asserts value is AckMessage;
export declare function assertAckMessageBody(value: unknown): asserts value is AckMessageBody;
//# sourceMappingURL=ack-message.d.ts.map