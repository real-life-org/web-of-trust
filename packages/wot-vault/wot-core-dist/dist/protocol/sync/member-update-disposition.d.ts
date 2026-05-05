export type MemberUpdateSignalAction = 'added' | 'removed';
export type MemberUpdateDisposition = 'store-pending-and-sync' | 'store-unverified-pending-and-sync' | 'upgrade-pending-and-sync' | 'ignore-lower-authority' | 'ignore-duplicate' | 'ignore-stale' | 'buffer-future-and-catch-up';
export type StoredMemberUpdateDisposition = 'store-pending-and-sync' | 'store-unverified-pending-and-sync';
export interface MemberUpdateSignal {
    spaceId: string;
    action: MemberUpdateSignalAction;
    memberDid: string;
    effectiveKeyGeneration: number;
    signerDid: string;
}
export interface SeenMemberUpdateSignal extends MemberUpdateSignal {
    storedDisposition: StoredMemberUpdateDisposition;
}
export interface EvaluateMemberUpdateDispositionInput {
    localKeyGeneration: number;
    knownAdminDids: readonly string[];
    knownMemberDids: readonly string[];
    seenUpdates: readonly SeenMemberUpdateSignal[];
    incomingUpdate: MemberUpdateSignal;
}
export declare function evaluateMemberUpdateDisposition(input: EvaluateMemberUpdateDispositionInput): MemberUpdateDisposition;
//# sourceMappingURL=member-update-disposition.d.ts.map