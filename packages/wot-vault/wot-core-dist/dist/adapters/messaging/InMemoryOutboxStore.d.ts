import { MessageEnvelope } from '../../types/messaging';
import { OutboxStore, OutboxEntry } from '../interfaces/OutboxStore';
export declare class InMemoryOutboxStore implements OutboxStore {
    private entries;
    enqueue(envelope: MessageEnvelope): Promise<void>;
    dequeue(envelopeId: string): Promise<void>;
    getPending(): Promise<OutboxEntry[]>;
    has(envelopeId: string): Promise<boolean>;
    incrementRetry(envelopeId: string): Promise<void>;
    count(): Promise<number>;
}
//# sourceMappingURL=InMemoryOutboxStore.d.ts.map