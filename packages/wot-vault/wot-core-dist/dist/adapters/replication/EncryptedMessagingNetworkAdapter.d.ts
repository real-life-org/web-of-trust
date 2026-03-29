import { NetworkAdapter, PeerId, DocumentId, Message, PeerMetadata } from '@automerge/automerge-repo';
import { MessagingAdapter } from '../interfaces/MessagingAdapter';
import { GroupKeyService } from '../../services/GroupKeyService';
/**
 * EncryptedMessagingNetworkAdapter — Bridge between automerge-repo and our MessagingAdapter.
 *
 * Responsibilities:
 * - Translates automerge-repo sync messages to/from encrypted MessageEnvelopes
 * - Routes messages through our existing MessagingAdapter (WebSocket relay)
 * - Encrypts outgoing sync data with per-space AES-256-GCM group keys
 * - Decrypts incoming sync data using GroupKeyService
 * - Maps DocumentId -> SpaceId for key lookup
 * - Maps PeerId = DID for routing
 */
export declare class EncryptedMessagingNetworkAdapter extends NetworkAdapter {
    private messaging;
    private identity;
    private groupKeyService;
    private ready;
    private readyResolve?;
    private readyPromise;
    private unsubMessage?;
    private docToSpace;
    private spacePeers;
    constructor(messaging: MessagingAdapter, identity: {
        getDid(): string;
    }, groupKeyService: GroupKeyService);
    isReady(): boolean;
    whenReady(): Promise<void>;
    connect(peerId: PeerId, peerMetadata?: PeerMetadata): void;
    send(message: Message): void;
    disconnect(): void;
    /**
     * Register a document -> space mapping.
     * Needed so we can look up the right group key when sending/receiving.
     */
    registerDocument(documentId: DocumentId, spaceId: string): void;
    /**
     * Unregister a document mapping.
     */
    unregisterDocument(documentId: DocumentId): void;
    /**
     * Register a peer (DID) as a member of a space.
     * Emits peer-candidate so automerge-repo starts syncing with this peer.
     */
    registerSpacePeer(spaceId: string, memberDid: string): void;
    /**
     * Unregister a peer from a space.
     */
    unregisterSpacePeer(spaceId: string, memberDid: string): void;
}
//# sourceMappingURL=EncryptedMessagingNetworkAdapter.d.ts.map