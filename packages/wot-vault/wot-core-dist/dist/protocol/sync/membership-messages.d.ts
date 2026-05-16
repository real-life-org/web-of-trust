export declare const DIDCOMM_PLAINTEXT_TYP: "application/didcomm-plain+json";
export declare const SPACE_INVITE_MESSAGE_TYPE: "https://web-of-trust.de/protocols/space-invite/1.0";
export declare const MEMBER_UPDATE_MESSAGE_TYPE: "https://web-of-trust.de/protocols/member-update/1.0";
export declare const KEY_ROTATION_MESSAGE_TYPE: "https://web-of-trust.de/protocols/key-rotation/1.0";
export type MemberUpdateAction = 'added' | 'removed';
export interface DidcommPlaintextMessage<Body = Record<string, unknown>, Type extends string = string> {
    id: string;
    typ: typeof DIDCOMM_PLAINTEXT_TYP;
    type: Type;
    from: string;
    to?: string[];
    created_time: number;
    thid?: string;
    pthid?: string;
    body: Body;
    [key: string]: unknown;
}
export interface CreatePlaintextMessageOptions<Body extends object, Type extends string> {
    id: string;
    type: Type;
    from: string;
    to?: string[];
    createdTime: number;
    body: Body;
    thid?: string;
    pthid?: string;
}
export interface SpaceContentKeyMaterial {
    generation: number;
    key: string;
}
export interface SpaceInviteBody {
    spaceId: string;
    brokerUrls: string[];
    currentKeyGeneration: number;
    spaceContentKeys: SpaceContentKeyMaterial[];
    spaceCapabilitySigningKey: string;
    adminDids: string[];
    capability: string;
}
export interface MemberUpdateBody {
    spaceId: string;
    action: MemberUpdateAction;
    memberDid: string;
    effectiveKeyGeneration: number;
    reason?: string;
}
export interface KeyRotationBody {
    spaceId: string;
    generation: number;
    spaceContentKey: string;
    spaceCapabilitySigningKey: string;
    capability: string;
}
export type SpaceInviteMessage = DidcommPlaintextMessage<SpaceInviteBody, typeof SPACE_INVITE_MESSAGE_TYPE> & {
    type: typeof SPACE_INVITE_MESSAGE_TYPE;
    to: string[];
};
export type MemberUpdateMessage = DidcommPlaintextMessage<MemberUpdateBody, typeof MEMBER_UPDATE_MESSAGE_TYPE> & {
    type: typeof MEMBER_UPDATE_MESSAGE_TYPE;
    to: string[];
};
export type KeyRotationMessage = DidcommPlaintextMessage<KeyRotationBody, typeof KEY_ROTATION_MESSAGE_TYPE> & {
    type: typeof KEY_ROTATION_MESSAGE_TYPE;
    to: string[];
};
export interface CreateSpaceInviteMessageOptions {
    id: string;
    from: string;
    to: string[];
    createdTime: number;
    body: SpaceInviteBody;
    thid?: string;
    pthid?: string;
}
export interface CreateMemberUpdateMessageOptions {
    id: string;
    from: string;
    to: string[];
    createdTime: number;
    body: MemberUpdateBody;
    thid?: string;
    pthid?: string;
}
export interface CreateKeyRotationMessageOptions {
    id: string;
    from: string;
    to: string[];
    createdTime: number;
    body: KeyRotationBody;
    thid?: string;
    pthid?: string;
}
export declare function createPlaintextMessage<Body extends object, Type extends string>(options: CreatePlaintextMessageOptions<Body, Type>): DidcommPlaintextMessage<Body, Type>;
export declare function parsePlaintextMessage(value: unknown): DidcommPlaintextMessage;
export declare function assertPlaintextMessage(value: unknown): asserts value is DidcommPlaintextMessage;
export declare function createSpaceInviteMessage(options: CreateSpaceInviteMessageOptions): SpaceInviteMessage;
export declare function createMemberUpdateMessage(options: CreateMemberUpdateMessageOptions): MemberUpdateMessage;
export declare function createKeyRotationMessage(options: CreateKeyRotationMessageOptions): KeyRotationMessage;
export declare function parseSpaceInviteMessage(value: unknown): SpaceInviteMessage;
export declare function parseMemberUpdateMessage(value: unknown): MemberUpdateMessage;
export declare function parseKeyRotationMessage(value: unknown): KeyRotationMessage;
export declare function assertSpaceInviteMessage(value: unknown): asserts value is SpaceInviteMessage;
export declare function assertMemberUpdateMessage(value: unknown): asserts value is MemberUpdateMessage;
export declare function assertKeyRotationMessage(value: unknown): asserts value is KeyRotationMessage;
export declare function assertSpaceInviteBody(value: unknown): asserts value is SpaceInviteBody;
export declare function assertMemberUpdateBody(value: unknown): asserts value is MemberUpdateBody;
export declare function assertKeyRotationBody(value: unknown): asserts value is KeyRotationBody;
//# sourceMappingURL=membership-messages.d.ts.map