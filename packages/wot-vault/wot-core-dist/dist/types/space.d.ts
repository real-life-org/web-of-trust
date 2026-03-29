export type ReplicationState = 'idle' | 'syncing' | 'error';
export interface SpaceInfo {
    id: string;
    type: 'personal' | 'shared';
    name?: string;
    description?: string;
    members: string[];
    createdAt: string;
}
export interface SpaceMemberChange {
    spaceId: string;
    did: string;
    action: 'added' | 'removed';
}
//# sourceMappingURL=space.d.ts.map