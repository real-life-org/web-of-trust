import { describe, expect, it } from 'vitest'
import {
  BROKER_ERROR_CLIENT_ACTIONS,
  KNOWN_BROKER_ERROR_CODES,
  assertKnownBrokerErrorCode,
  classifyBrokerErrorClientAction,
  isKnownBrokerErrorCode,
  parseBrokerErrorBody,
} from '../src/protocol'

const SYNC_003_BROKER_ERROR_CODES = [
  'DOC_NOT_FOUND',
  'CAPABILITY_INVALID',
  'CAPABILITY_EXPIRED',
  'CAPABILITY_GENERATION_STALE',
  'DEVICE_NOT_REGISTERED',
  'DEVICE_REVOKED',
  'DEVICE_ID_CONFLICT',
  'SEQ_COLLISION_DETECTED',
  'MALFORMED_MESSAGE',
  'AUTH_INVALID',
  'NONCE_REPLAY',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const

describe('Sync 003 broker error catalog', () => {
  it('exposes exactly the known wot-sync@0.1 broker error codes from Sync 003', () => {
    expect(KNOWN_BROKER_ERROR_CODES).toEqual(SYNC_003_BROKER_ERROR_CODES)

    for (const code of SYNC_003_BROKER_ERROR_CODES) {
      expect(isKnownBrokerErrorCode(code), code).toBe(true)
      expect(() => assertKnownBrokerErrorCode(code), code).not.toThrow()
    }
  })

  it('rejects unknown codes instead of treating them as extension semantics', () => {
    expect(isKnownBrokerErrorCode('BROKER_BUSY')).toBe(false)
    expect(() => assertKnownBrokerErrorCode('BROKER_BUSY')).toThrow()
    expect(() => parseBrokerErrorBody({ code: 'BROKER_BUSY', message: 'Try later' })).toThrow()
  })

  it('parses a valid error body with a known code and human-readable message', () => {
    expect(parseBrokerErrorBody({
      code: 'DOC_NOT_FOUND',
      message: 'Unbekannte docId',
    })).toEqual({
      code: 'DOC_NOT_FOUND',
      message: 'Unbekannte docId',
    })
  })

  it('rejects missing, non-string, or empty human-readable messages', () => {
    expect(typeof parseBrokerErrorBody).toBe('function')

    const invalidMessages = [
      { code: 'DOC_NOT_FOUND' },
      { code: 'DOC_NOT_FOUND', message: '' },
      { code: 'DOC_NOT_FOUND', message: 404 },
      { code: 'DOC_NOT_FOUND', message: null },
    ]

    for (const body of invalidMessages) {
      expect(() => parseBrokerErrorBody(body), JSON.stringify(body)).toThrow()
    }
  })

  it('tolerates unknown extra body fields as non-authoritative metadata', () => {
    expect(parseBrokerErrorBody({
      code: 'RATE_LIMITED',
      message: 'Rate-Limit ueberschritten',
      retryAfterSeconds: 30,
      brokerTraceId: 'trace-123',
    })).toMatchObject({
      code: 'RATE_LIMITED',
      message: 'Rate-Limit ueberschritten',
    })
  })

  it('maps only explicit Sync 003 client actions and leaves other codes generic', () => {
    expect(classifyBrokerErrorClientAction('SEQ_COLLISION_DETECTED')).toEqual(
      BROKER_ERROR_CLIENT_ACTIONS.restoreCloneRecovery,
    )
    expect(classifyBrokerErrorClientAction('CAPABILITY_EXPIRED')).toEqual(
      BROKER_ERROR_CLIENT_ACTIONS.requestFreshCapabilityViaPeerContact,
    )

    for (const code of SYNC_003_BROKER_ERROR_CODES) {
      if (code === 'SEQ_COLLISION_DETECTED' || code === 'CAPABILITY_EXPIRED') continue
      expect(classifyBrokerErrorClientAction(code), code).toEqual(
        BROKER_ERROR_CLIENT_ACTIONS.noNormativeAction,
      )
    }
  })
})
