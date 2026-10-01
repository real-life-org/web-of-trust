/**
 * TracedOutboxMessagingAdapter — Decorator that wraps OutboxMessagingAdapter
 * and logs all messaging operations to the TraceLog.
 *
 * Traces: send, receive, flush, connect, disconnect, state changes.
 * Makes the outbox message flow fully visible in the debug dashboard.
 */

import type { MessagingAdapter, WireMessage } from '../../ports/MessagingAdapter'
import { wireMessageRecipient, wireMessageSender } from '../../ports/MessagingAdapter'
import type {
  DeliveryReceipt,
  MessagingState,
} from '../../types/messaging'
import type { OutboxStore } from '../../ports/OutboxStore'
import type { OutboxMessagingAdapter } from './OutboxMessagingAdapter'
import type { ControlFrame, ControlFrameReceipt } from '../../protocol/sync/control-frame-transport'
import { ControlFrameRejectedError } from '../../protocol/sync/control-frame-transport'
import { controlFrameDocId } from '../../protocol/sync/control-frame-doc-id'
import { getTraceLog } from '../../storage/TraceLog'
import type { TraceEntry } from '../../storage/TraceLog'

/** Tracing must never change the outcome of the operation it observes. */
function safeTrace(entry: Omit<TraceEntry, 'id' | 'timestamp'>): void {
  try { getTraceLog().log(entry) } catch { /* ignore */ }
}

/** Extract envelope header fields (no body content) for tracing. */
function envelopeHeaders(envelope: WireMessage): Record<string, unknown> {
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

function shortDid(did: string | undefined): string {
  return did ? `${did.slice(0, 24)}…` : 'unknown'
}

/**
 * A relay `error` frame (`{ type:'error', code?, message?, thid? }`, fanned out
 * by WebSocketMessagingAdapter.handleControlFrameError) carries no envelope
 * headers — its meaning is in code/message/thid. wot#381 (1): trace those, and
 * trace the frame as the failure it is.
 */
interface RelayErrorFrame {
  type: 'error'
  code?: unknown
  message?: unknown
  thid?: unknown
  currentGeneration?: unknown
}

function isRelayErrorFrame(frame: unknown): frame is RelayErrorFrame {
  return typeof frame === 'object' && frame !== null && (frame as { type?: unknown }).type === 'error'
}

function traceReceivedFrame(envelope: WireMessage): void {
  if (isRelayErrorFrame(envelope)) {
    const code = typeof envelope.code === 'string' ? envelope.code : undefined
    const message = typeof envelope.message === 'string' ? envelope.message : undefined
    const meta: Record<string, unknown> = { type: 'error' }
    if (code !== undefined) meta.code = code
    if (message !== undefined) meta.message = message
    if (typeof envelope.thid === 'string') meta.thid = envelope.thid
    if (typeof envelope.currentGeneration === 'number') meta.currentGeneration = envelope.currentGeneration
    getTraceLog().log({
      store: 'relay',
      operation: 'receive',
      label: code ? `receive error ${code} ← relay` : 'receive error ← relay',
      durationMs: 0,
      success: false,
      error: code && message ? `${code}: ${message}` : (code ?? message ?? 'relay error'),
      meta,
    })
    return
  }
  getTraceLog().log({
    store: 'relay',
    operation: 'receive',
    label: `receive ${envelope.type} ← ${shortDid(wireMessageSender(envelope))}`,
    durationMs: 0,
    success: true,
    meta: envelopeHeaders(envelope),
  })
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
      this.sendControlFrame = (frame) => this.tracedControlFrame(frame)
    }
    if (typeof this.inner.rebindDeviceId === 'function') {
      this.rebindDeviceId = (newDeviceId) => this.inner.rebindDeviceId!(newDeviceId)
    }
  }

  /**
   * wot#383: a relay error correlated to an in-flight control frame (e.g.
   * CAPABILITY_EXPIRED on present-capability) settles the frame's own promise
   * and never reaches the message callbacks — so the receive trace cannot see
   * it. Trace the control frame where it passes through here instead: once per
   * frame, success or failure, with the docId and the broker code. The promise
   * result is returned/rethrown unchanged.
   */
  private async tracedControlFrame(frame: ControlFrame): Promise<ControlFrameReceipt> {
    const start = performance.now()
    const docId = controlFrameDocId(frame)
    const target = docId ? `${docId.slice(0, 8)}…` : 'unknown'
    try {
      const receipt = await this.inner.sendControlFrame!(frame)
      safeTrace({
        store: 'relay',
        operation: 'send',
        label: `control ${frame.type} ${target} delivered`,
        durationMs: Math.round(performance.now() - start),
        success: true,
        meta: { frameType: frame.type, docId },
      })
      return receipt
    } catch (err) {
      const code = err instanceof ControlFrameRejectedError ? err.code : undefined
      const meta: Record<string, unknown> = { frameType: frame.type, docId }
      if (code !== undefined) meta.code = code
      if (err instanceof ControlFrameRejectedError && err.currentGeneration !== undefined) {
        meta.currentGeneration = err.currentGeneration
      }
      safeTrace({
        store: 'relay',
        operation: 'send',
        label: code ? `control ${frame.type} ${target} rejected ${code}` : `control ${frame.type} ${target} failed`,
        durationMs: Math.round(performance.now() - start),
        success: false,
        error: err instanceof Error ? err.message : String(err),
        meta,
      })
      throw err
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

  /**
   * wot#381 (3): the transport hands the SAME frame object to every subscriber
   * (3–5 components subscribe in the app). Tracing inside each subscriber's
   * wrapper logged one frame 3–5 times, which reads as repeated delivery. The
   * frame object is the dedup key: a redelivery is a new parsed object and is
   * traced again, as it should be. Dispatch itself is untouched — every
   * subscriber still receives the frame through its own inner registration,
   * so the transport's per-callback error isolation and ack semantics stay.
   */
  private readonly tracedFrames = new WeakSet<object>()

  onMessage(callback: (envelope: WireMessage) => void | Promise<void>): () => void {
    return this.inner.onMessage((envelope) => {
      if (typeof envelope === 'object' && envelope !== null && !this.tracedFrames.has(envelope)) {
        this.tracedFrames.add(envelope)
        traceReceivedFrame(envelope)
      }
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
