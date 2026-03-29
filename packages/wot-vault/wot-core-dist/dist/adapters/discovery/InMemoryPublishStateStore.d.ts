import { PublishStateField, PublishStateStore } from '../interfaces/PublishStateStore';
/**
 * In-memory implementation of PublishStateStore.
 *
 * Useful for tests. Data is lost on page reload.
 */
export declare class InMemoryPublishStateStore implements PublishStateStore {
    private dirty;
    markDirty(did: string, field: PublishStateField): Promise<void>;
    clearDirty(did: string, field: PublishStateField): Promise<void>;
    getDirtyFields(did: string): Promise<Set<PublishStateField>>;
}
//# sourceMappingURL=InMemoryPublishStateStore.d.ts.map