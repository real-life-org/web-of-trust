import { DocumentId, AutomergeUrl, StorageAdapterInterface, DocHandle } from '@automerge/automerge-repo';
import { ReplicationAdapter, SpaceHandle } from '../interfaces/ReplicationAdapter';
import { Subscribable } from '../interfaces/Subscribable';
import { MessagingAdapter } from '../interfaces/MessagingAdapter';
import { SpaceInfo, SpaceMemberChange, ReplicationState } from '../../types/space';
import { GroupKeyService } from '../../services/GroupKeyService';
import { SpaceMetadataStorage } from '../interfaces/SpaceMetadataStorage';
import { WotIdentity } from '../../identity/WotIdentity';
import { SpaceStorageAdapter } from '../interfaces/SpaceStorageAdapter';
interface SpaceState {
    info: SpaceInfo;
    documentId: DocumentId;
    documentUrl: AutomergeUrl;
    handles: Set<AutomergeSpaceHandle<any>>;
    memberEncryptionKeys: Map<string, Uint8Array>;
}
export interface AutomergeReplicationAdapterConfig {
    identity: WotIdentity;
    messaging: MessagingAdapter;
    groupKeyService: GroupKeyService;
    /** New: automerge-repo metadata storage (no docBinary) */
    metadataStorage?: SpaceMetadataStorage;
    /** @deprecated Use metadataStorage instead */
    storage?: SpaceStorageAdapter;
    /** Optional: automerge-repo StorageAdapter for doc persistence (e.g. IndexedDB) */
    repoStorage?: StorageAdapterInterface;
}
declare class AutomergeSpaceHandle<T> implements SpaceHandle<T> {
    readonly id: string;
    private spaceState;
    private docHandle;
    private remoteUpdateCallbacks;
    private closed;
    private localChanging;
    private unsubChange?;
    constructor(spaceState: SpaceState, docHandle: DocHandle<T>);
    info(): SpaceInfo;
    getDoc(): T;
    transact(fn: (doc: T) => void): void;
    onRemoteUpdate(callback: () => void): () => void;
    _notifyRemoteUpdate(): void;
    close(): void;
}
export declare class AutomergeReplicationAdapter implements ReplicationAdapter {
    private identity;
    private messaging;
    private groupKeyService;
    private metadataStorage;
    private repoStorage;
    private spaces;
    private state;
    private memberChangeCallbacks;
    private spacesSubscribers;
    private unsubscribeMessaging;
    private repo;
    private networkAdapter;
    constructor(config: AutomergeReplicationAdapterConfig);
    start(): Promise<void>;
    /**
     * Restore spaces from metadata storage.
     * Called on start() and can be called again after remote sync
     * delivers new space metadata (e.g. multi-device sync).
     * Only loads spaces that aren't already known.
     */
    restoreSpacesFromMetadata(): Promise<void>;
    stop(): Promise<void>;
    getState(): ReplicationState;
    createSpace<T>(type: 'personal' | 'shared', initialDoc: T, meta?: {
        name?: string;
        description?: string;
    }): Promise<SpaceInfo>;
    getSpaces(): Promise<SpaceInfo[]>;
    watchSpaces(): Subscribable<SpaceInfo[]>;
    private _getSpacesSnapshot;
    private _notifySpacesSubscribers;
    getSpace(spaceId: string): Promise<SpaceInfo | null>;
    openSpace<T>(spaceId: string): Promise<SpaceHandle<T>>;
    addMember(spaceId: string, memberDid: string, memberEncryptionPublicKey: Uint8Array): Promise<void>;
    removeMember(spaceId: string, memberDid: string): Promise<void>;
    onMemberChange(callback: (change: SpaceMemberChange) => void): () => void;
    getKeyGeneration(spaceId: string): number;
    requestSync(_spaceId: string): Promise<void>;
    _persistSpaceMetadata(space: SpaceState): Promise<void>;
    private handleMessage;
    private handleSpaceInvite;
    private handleKeyRotation;
    private handleMemberUpdate;
}
export {};
//# sourceMappingURL=AutomergeReplicationAdapter.d.ts.map