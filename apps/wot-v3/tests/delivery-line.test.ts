// The delivery line of an own document (ingest.ts deliveryOf, screens/chat/delivery-word.ts): the
// counterpart's answers of Delivery 0.85 (RLTP-DEL-6140) and profile 0.29 §5: a refusal names its code,
// a held document is "open at the recipient" and not final; `carrier-refused-retriable` stays a wait.
import { describe, expect, it } from 'vitest'
import { deliveryOf, statusFinal } from '../src/adapters/rltp/ingest'

type DeliveryItemView = Parameters<typeof deliveryOf>[0][number]
import { deliveryWord } from '../src/screens/chat/delivery-word'
import { de } from '../src/i18n/de'
import { en } from '../src/i18n/en'
import { interpolate } from '../src/i18n/utils'

const base = { digest: 'd', type: 't', threadId: 't', contactId: 'c', attempt: 1, submittedAt: 0, updatedAt: 0 }
const item = (x: Partial<DeliveryItemView>): DeliveryItemView => ({ ...base, status: 'submitted', ...x }) as DeliveryItemView
const word = (x: Partial<DeliveryItemView>, lang: 'en' | 'de') => deliveryWord(deliveryOf([item(x)]), { lang, t: lang === 'en' ? en : de, f: interpolate })

describe('the delivery line', () => {
  it('a refusal of the recipient carries its code', () => {
    const x = { status: 'failed', reason: 'rejected-by-receiver', code: 'unsupportedType' } as const
    expect(deliveryOf([item(x)])).toEqual({ phase: 'failed', reason: 'rejected', code: 'unsupportedType', retry: { ok: false, reason: 'not-supported' } })
    expect(word(x, 'en')).toBe('Rejected by the recipient (unsupportedType)')
    expect(word(x, 'de')).toBe('Vom Empfänger abgelehnt (unsupportedType)')
  })

  it('another failure has no code and reads as before', () => {
    const x = { status: 'failed', reason: 'expired-by-adapter-policy' } as const
    expect(deliveryOf([item(x)])).toEqual({ phase: 'failed', reason: 'expired', retry: { ok: false, reason: 'not-supported' } })
    expect(word(x, 'en')).toBe('Not delivered')
    expect(word(x, 'de')).toBe('Nicht zugestellt')
  })

  it('accepted and held: arrived, open at the recipient; not final (a late ack or a refusal may follow)', () => {
    const x = { status: 'accepted', held: true } as const
    expect(deliveryOf([item(x)])).toEqual({ phase: 'accepted', held: true })
    expect(word(x, 'en')).toBe('Arrived, open at the recipient')
    expect(word(x, 'de')).toBe('Beim Empfänger angekommen, dort offen')
    expect(statusFinal(deliveryOf([item(x)]))).toBe(false)
  })

  it('accepted without held reads as sent; a late acknowledgement after held reads delivered', () => {
    expect(deliveryOf([item({ status: 'accepted' })])).toEqual({ phase: 'accepted' })
    expect(word({ status: 'accepted' }, 'en')).toBe('Sent ✓')
    expect(word({ status: 'delivered' }, 'en')).toBe('Delivered ✓✓')
    expect(statusFinal(deliveryOf([item({ status: 'delivered' })]))).toBe(true)
  })

  it('carrier-refused-retriable stays a wait', () => {
    const x = { status: 'submitted', awaiting: 'carrier-refused-retriable' } as const
    expect(deliveryOf([item(x)])).toEqual({ phase: 'queued', reason: 'carrier-retry' })
    expect(word(x, 'en')).toBe('Sending, waiting for network')
  })
})
