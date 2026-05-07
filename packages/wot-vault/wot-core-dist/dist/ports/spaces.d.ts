import { SpaceDocMeta, SpaceInfo } from '../types/space';
export interface SpaceListSubscription {
    subscribe(callback: (spaces: SpaceInfo[]) => void): () => void;
    getValue(): SpaceInfo[];
}
export interface SpaceReplicationPort {
    createSpace<T>(type: SpaceInfo['type'], initialDoc: T, meta?: {
        name?: string;
        description?: string;
        appTag?: string;
    }): Promise<SpaceInfo>;
    updateSpace(spaceId: string, meta: SpaceDocMeta): Promise<void>;
    getSpaces(): Promise<SpaceInfo[]>;
    getSpace(spaceId: string): Promise<SpaceInfo | null>;
    watchSpaces(): SpaceListSubscription;
    addMember(spaceId: string, memberDid: string, memberEncryptionPublicKey: Uint8Array): Promise<void>;
    removeMember(spaceId: string, memberDid: string): Promise<void>;
    leaveSpace(spaceId: string): Promise<void>;
    requestSync(spaceId: string): Promise<void>;
}
export interface SpaceMemberKeyDirectory {
    resolveMemberEncryptionKey(did: string): Promise<Uint8Array | null>;
}
//# sourceMappingURL=spaces.d.ts.map