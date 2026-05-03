import { OutboxStore, OutboxEntry } from '../../ports/OutboxStore';
import { MessageEnvelope } from '../../types/messaging';
import { Subscribable } from '../../ports/Subscribable';
export interface PersonalDocFunctions {
    getPersonalDoc: () => any;
    changePersonalDoc: (fn: (doc: any) => void, options?: {
        background?: boolean;
    }) => any;
    onPersonalDocChange: (callback: () => void) => () => void;
}
export declare class PersonalDocOutboxStore implements OutboxStore {
    private getPersonalDoc;
    private changePersonalDoc;
    private onPersonalDocChange;
    constructor(fns: PersonalDocFunctions);
    enqueue(envelope: MessageEnvelope): Promise<void>;
    dequeue(envelopeId: string): Promise<void>;
    getPending(): Promise<OutboxEntry[]>;
    has(envelopeId: string): Promise<boolean>;
    incrementRetry(envelopeId: string): Promise<void>;
    count(): Promise<number>;
    watchPendingCount(): Subscribable<number>;
}
//# sourceMappingURL=AutomergeOutboxStore.d.ts.map