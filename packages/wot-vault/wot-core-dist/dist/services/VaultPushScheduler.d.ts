/**
 * VaultPushScheduler — Immediate vs. debounced persistence scheduling.
 *
 * Two modes:
 * - pushImmediate(): Explicit user actions (profile save, task create, contact add).
 *   Pushes right away, deduplicates via Automerge.getHeads() comparison.
 * - pushDebounced(): Streaming changes (collaborative text editing) or remote sync.
 *   Waits for a pause before pushing.
 *
 * In-flight deduplication: If a push is already running and another comes in,
 * at most one additional push is queued (not N).
 *
 * Lifecycle: Registers visibilitychange + beforeunload to flush pending work
 * when the user leaves the tab.
 */
export interface VaultPushSchedulerConfig {
    /** The actual push function (encrypt + HTTP). */
    pushFn: () => Promise<void>;
    /** Returns a string representing current doc state (Automerge.getHeads().join(',')). Null = no doc yet. */
    getHeadsFn: () => string | null;
    /** Debounce delay in ms. Default: 5000. */
    debounceMs?: number;
}
export declare class VaultPushScheduler {
    private pushFn;
    private getHeadsFn;
    private debounceMs;
    private lastPushedHeads;
    private debounceTimer;
    private pushing;
    private pendingAfterPush;
    private destroyed;
    private onVisibilityChange;
    private onBeforeUnload;
    constructor(config: VaultPushSchedulerConfig);
    /** Set initial heads (e.g. after loading from vault — vault already has this state). */
    setLastPushedHeads(heads: string | null): void;
    /** Explicit user action — push immediately (deduplicated). */
    pushImmediate(): void;
    /** Streaming / remote sync — push after debounce delay. */
    pushDebounced(): void;
    /** Flush any pending debounced push immediately (lifecycle events). */
    flush(): void;
    /** Clean up timers and lifecycle handlers. */
    destroy(): void;
    private clearDebounce;
    private schedulePush;
}
//# sourceMappingURL=VaultPushScheduler.d.ts.map