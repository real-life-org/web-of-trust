export declare const DIDCOMM_PLAINTEXT_TYP: "application/didcomm-plain+json";
export declare const MEMBER_UPDATE_MESSAGE_TYPE: "https://web-of-trust.de/protocols/member-update/1.0";
export type MemberUpdateAction = 'added' | 'removed';
export interface DidcommPlaintextMessage<Body> {
    id: string;
    typ: typeof DIDCOMM_PLAINTEXT_TYP;
    type: string;
    from: string;
    to: string[];
    created_time: number;
    thid?: string;
    pthid?: string;
    body: Body;
    [key: string]: unknown;
}
export interface MemberUpdateBody {
    spaceId: string;
    action: MemberUpdateAction;
    memberDid: string;
    effectiveKeyGeneration: number;
    reason?: string;
}
export type MemberUpdateMessage = DidcommPlaintextMessage<MemberUpdateBody> & {
    type: typeof MEMBER_UPDATE_MESSAGE_TYPE;
};
export interface CreateMemberUpdateMessageOptions {
    id: string;
    from: string;
    to: string[];
    createdTime: number;
    body: MemberUpdateBody;
    thid?: string;
    pthid?: string;
}
export declare function createMemberUpdateMessage(options: CreateMemberUpdateMessageOptions): MemberUpdateMessage;
export declare function parseMemberUpdateMessage(value: unknown): MemberUpdateMessage;
export declare function assertMemberUpdateMessage(value: unknown): asserts value is MemberUpdateMessage;
export declare function assertMemberUpdateBody(value: unknown): asserts value is MemberUpdateBody;
//# sourceMappingURL=membership-messages.d.ts.map