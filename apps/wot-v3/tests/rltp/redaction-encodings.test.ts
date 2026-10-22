// @vitest-environment node
// Review 434 S5: the redaction (lib/error-filter.ts) against the encodings the trust-protocol lib
// actually produces, not hand-made look-alikes: the anchor (did:key) and the key agreement.
import { expect, it, vi } from 'vitest'
import { redactText } from '../../src/lib/error-filter'

/** the one lib function this test needs; loaded like the fault-injection tests load the real lib */
interface LibContexts {
  labeledContext(rootIkm: Uint8Array, label: string): Promise<{ anchor: string; keyAgreement: string }>
}

it('anchor and key agreement of a lib context never pass the redaction', async () => {
  const { labeledContext } = await vi.importActual<LibContexts>('@real-life/trust-protocol')
  const ctx = await labeledContext(new Uint8Array(32).fill(7), 'persona/redaction')
  for (const v of [ctx.anchor, ctx.keyAgreement]) {
    const out = redactText(`open failed for ${v} in step 2`)
    expect(out, v).not.toContain(v)
    expect(out).not.toContain(v.slice(-24))
  }
})
