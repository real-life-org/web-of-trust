export type ReplicationState = 'idle' | 'syncing' | 'error';
export interface SpaceInfo {
    id: string;
    type: 'personal' | 'shared';
    name?: string;
    description?: string;
    image?: string;
    modules?: string[];
    /** App identifier for cross-app space isolation (e.g. 'rls', 'wot-demo') */
    appTag?: string;
    members: string[];
    createdAt: string;
}
export interface SpaceDocMeta {
    name?: string;
    description?: string;
    image?: string;
    modules?: string[];
}
export interface SpaceMemberChange {
    spaceId: string;
    did: string;
    action: 'added' | 'removed';
}
//# sourceMappingURL=space.d.ts.map