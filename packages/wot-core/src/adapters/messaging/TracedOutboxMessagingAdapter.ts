/**
 * TracedOutboxMessagingAdapter — Decorator that wraps OutboxMessagingAdapter
 * and logs all messaging operations to the TraceLog.
 *
 * Traces: send, receive, flush, connect, disconnect, state changes.
 * Makes the outbox message flow fully visible in the debug dashboard.
 */

import type { MessagingAdapter } from '../interfaces/MessagingAdapter'
import type {
  MessageEnvelope,
  DeliveryReceipt,
  MessagingState,
} from '../../types/messaging'
import type { OutboxStore } from '../interfaces/OutboxStore'
import type { OutboxMessagingAdapter } from './OutboxMessagingAdapter'
import { getTraceLog } from '../../storage/TraceLog'

/** Extract envelope header fields (everything except payload + signature) for tracing. */
function envelopeHeaders(envelope: MessageEnvelope): Record<string, unknown> {
  return {
    id: envelope.id,
    v: envelope.v,
    type: envelope.type,
    fromDid: envelope.fromDid,
    toDid: envelope.toDid,
    createdAt: envelope.createdAt,
    encoding: envelope.encoding,
    ref: envelope.ref,
    payloadSize: envelope.payload?.length,
  }
}

export class TracedOutboxMessagingAdapter implements MessagingAdapter {
  constructor(private inner: OutboxMessagingAdapter) {}

  async connect(myDid: string): Promise<void> {
    const trace = getTraceLog()
    const start = performance.now()
    try {
      await this.inner.connect(myDid)
      trace.log({
        store: 'relay',
        operation: 'connect',
        label: `relay connect ${myDid.slice(0, 24)}…`,
        durationMs: Math.round(performance.now() - start),
        success: true,
        meta: { did: myDid },
      })
    } catch (err) {
      trace.log({
        store: 'relay',
        operation: 'connect',
        label: `relay connect ${myDid.slice(0, 24)}…`,
        durationMs: Math.round(performance.now() - start),
        success: false,
        error: err instanceof Error ? err.message : String(err),
        meta: { did: myDid },
      })
      throw err
    }
  }

  async disconnect(): Promise<void> {
    const trace = getTraceLog()
    await this.inner.disconnect()
    trace.log({
      store: 'relay',
      operation: 'disconnect',
      label: 'relay disconnect',
      durationMs: 0,
      success: true,
    })
  }

  getState(): MessagingState {
    return this.inner.getState()
  }

  onStateChange(callback: (state: MessagingState) => void): () => void {
    return this.inner.onStateChange((state) => {
      const opMap: Record<MessagingState, string> = {
        connected: 'connect',
        disconnected: 'disconnect',
        connecting: 'connect',
        error: 'error',
      }
      getTraceLog().log({
        store: 'relay',
        operation: opMap[state] as any,
        label: `relay ${state}`,
        durationMs: 0,
        success: state !== 'error',
        meta: { state },
      })
      callback(state)
    })
  }

  async send(envelope: MessageEnvelope): Promise<DeliveryReceipt> {
    const trace = getTraceLog()
    const start = performance.now()
    try {
      const receipt = await this.inner.send(envelope)
      trace.log({
        store: receipt.reason === 'queued-in-outbox' ? 'outbox' : 'relay',
        operation: 'send',
        label: `send ${envelope.type} → ${envelope.toDid.slice(0, 24)}…`,
        durationMs: Math.round(performance.now() - start),
        success: true,
        meta: {
          ...envelopeHeaders(envelope),
          status: receipt.status,
          reason: receipt.reason,
        },
      })
      return receipt
    } catch (err) {
      trace.log({
        store: 'relay',
        operation: 'send',
        label: `send ${envelope.type} → ${envelope.toDid.slice(0, 24)}…`,
        durationMs: Math.round(performance.now() - start),
        success: false,
        error: err instanceof Error ? err.message : String(err),
        meta: envelopeHeaders(envelope),
      })
      throw err
    }
  }

  onMessage(callback: (envelope: MessageEnvelope) => void | Promise<void>): () => void {
    return this.inner.onMessage((envelope) => {
      getTraceLog().log({
        store: 'relay',
        operation: 'receive',
        label: `receive ${envelope.type} ← ${envelope.fromDid.slice(0, 24)}…`,
        durationMs: 0,
        success: true,
        meta: envelopeHeaders(envelope),
      })
      return callback(envelope)
    })
  }

  onReceipt(callback: (receipt: DeliveryReceipt) => void): () => void {
    return this.inner.onReceipt(callback)
  }

  async registerTransport(did: string, transportAddress: string): Promise<void> {
    return this.inner.registerTransport(did, transportAddress)
  }

  async resolveTransport(did: string): Promise<string | null> {
    return this.inner.resolveTransport(did)
  }

  // --- Outbox-specific methods (delegate to inner) ---

  async flushOutbox(): Promise<void> {
    const trace = getTraceLog()
    const start = performance.now()
    const outbox = this.inner.getOutboxStore()
    const pendingBefore = await outbox.count()

    try {
      await this.inner.flushOutbox()
      const pendingAfter = await outbox.count()
      trace.log({
        store: 'outbox',
        operation: 'flush',
        label: `flush outbox ${pendingBefore} → ${pendingAfter}`,
        durationMs: Math.round(performance.now() - start),
        success: true,
        meta: { pendingBefore, pendingAfter, delivered: pendingBefore - pendingAfter },
      })
    } catch (err) {
      trace.log({
        store: 'outbox',
        operation: 'flush',
        label: 'flush outbox failed',
        durationMs: Math.round(performance.now() - start),
        success: false,
        error: err instanceof Error ? err.message : String(err),
        meta: { pendingBefore },
      })
      throw err
    }
  }

  getOutboxStore(): OutboxStore {
    return this.inner.getOutboxStore()
  }
}
