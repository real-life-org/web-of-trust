/**
 * TracedOutboxMessagingAdapter — Decorator that wraps OutboxMessagingAdapter
 * and logs all messaging operations to the TraceLog.
 *
 * Traces: send, receive, flush, connect, disconnect, state changes.
 * Makes the outbox message flow fully visible in the debug dashboard.
 */

import type { MessagingAdapter, WireMessage } from '../../ports/MessagingAdapter'
import { wireMessageRecipient, wireMessageSender } from '../../ports/MessagingAdapter'
import { isDidcommMessage } from '../../protocol/messaging/inbox-message'
import type {
  DeliveryReceipt,
  MessageEnvelope,
  MessagingState,
} from '../../types/messaging'
import type { OutboxStore } from '../../ports/OutboxStore'
import type { OutboxMessagingAdapter } from './OutboxMessagingAdapter'
import type { ControlFrame, ControlFrameReceipt } from '../../protocol/sync/control-frame-transport'
import { getTraceLog } from '../../storage/TraceLog'

/** Extract envelope header fields (no payload/body content) for tracing — both families (VE-8). */
function envelopeHeaders(envelope: WireMessage): Record<string, unknown> {
  if (isDidcommMessage(envelope)) {
    return {
      id: envelope.id,
      typ: envelope.typ,
      type: envelope.type,
      from: envelope.from,
      to: envelope.to,
      created_time: envelope.created_time,
      thid: envelope.thid,
    }
  }
  const oldWorld = envelope as MessageEnvelope
  return {
    id: oldWorld.id,
    v: oldWorld.v,
    type: oldWorld.type,
    fromDid: oldWorld.fromDid,
    toDid: oldWorld.toDid,
    createdAt: oldWorld.createdAt,
    encoding: oldWorld.encoding,
    ref: oldWorld.ref,
    payloadSize: oldWorld.payload?.length,
  }
}

function shortDid(did: string | undefined): string {
  return did ? `${did.slice(0, 24)}…` : 'unknown'
}

export class TracedOutboxMessagingAdapter implements MessagingAdapter {
  /**
   * VE-9/VE-11 control-frame passthrough (Durable Wiring / VE-DW8): forward the
   * feature-detected sendControlFrame down the wrapper chain (Traced → Outbox →
   * WebSocket) so the log-sync L1 gate sees a control-frame-capable transport.
   * Bound ONLY when the wrapped OutboxMessagingAdapter exposes it (which it does
   * iff ITS inner transport supports control frames).
   */
  sendControlFrame?: (frame: ControlFrame) => Promise<ControlFrameReceipt>

  /** VE-11: forward a deviceId re-bind down the wrapper chain (Traced → Outbox → WebSocket). */
  rebindDeviceId?: (newDeviceId: string) => Promise<void>

  constructor(private inner: OutboxMessagingAdapter) {
    if (typeof this.inner.sendControlFrame === 'function') {
      this.sendControlFrame = (frame) => this.inner.sendControlFrame!(frame)
    }
    if (typeof this.inner.rebindDeviceId === 'function') {
      this.rebindDeviceId = (newDeviceId) => this.inner.rebindDeviceId!(newDeviceId)
    }
  }

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

  async send(envelope: WireMessage): Promise<DeliveryReceipt> {
    const trace = getTraceLog()
    const start = performance.now()
    try {
      const receipt = await this.inner.send(envelope)
      trace.log({
        store: receipt.reason === 'queued-in-outbox' ? 'outbox' : 'relay',
        operation: 'send',
        label: `send ${envelope.type} → ${shortDid(wireMessageRecipient(envelope))}`,
        durationMs: Math.round(performance.now() - start),
        // #236 (TC4): a thid-correlated write-path reject now RESOLVES the send with
        // a typed {status:'failed'} receipt — trace it as the failure it is.
        success: receipt.status !== 'failed',
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
        label: `send ${envelope.type} → ${shortDid(wireMessageRecipient(envelope))}`,
        durationMs: Math.round(performance.now() - start),
        success: false,
        error: err instanceof Error ? err.message : String(err),
        meta: envelopeHeaders(envelope),
      })
      throw err
    }
  }

  onMessage(callback: (envelope: WireMessage) => void | Promise<void>): () => void {
    return this.inner.onMessage((envelope) => {
      getTraceLog().log({
        store: 'relay',
        operation: 'receive',
        label: `receive ${envelope.type} ← ${shortDid(wireMessageSender(envelope))}`,
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
