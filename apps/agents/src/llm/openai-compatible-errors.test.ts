import { describe, expect, test } from 'bun:test'
import { mapHttpError } from './openai-compatible-errors.ts'
import { isCloudProviderError, isCreditRefusal, isFallbackable, type CloudProviderError } from './errors.ts'

const cloudError = (err: Error): CloudProviderError => {
  if (!isCloudProviderError(err)) throw new Error(`expected a cloud provider error, got ${err.name}`)
  return err
}

// Production 2026-10-10 09:22:49 UTC: OpenRouter's answer to a gpt-5.4 tool
// turn, as journalctl showed it, without metadata.remedy_hint, which the log
// line cut.
const IN_FLIGHT_BODY = JSON.stringify({ error: {
  message: 'This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits.',
  code: 402,
  metadata: { reason: 'in_flight_budget_exhausted', limit_source: 'openrouter_in_flight_budget' },
} })

describe('mapHttpError — HTTP 402', () => {
  test('in_flight_budget_exhausted is a transient in-flight limit worded by the provider', () => {
    const err = cloudError(mapHttpError('openrouter', 402, IN_FLIGHT_BODY, null))
    expect(err.code).toBe('in_flight_limit')
    expect(err.status).toBe(402)
    expect(err.provider).toBe('openrouter')
    expect(err.message).toBe('openrouter in-flight budget exhausted (HTTP 402, in_flight_budget_exhausted): This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits.')
    expect(isFallbackable(err) && isCreditRefusal(err)).toBe(true)
  })

  test('a 402 with another or no reason is insufficient credits', () => {
    const other = cloudError(mapHttpError('openrouter', 402, JSON.stringify({ error: { message: 'Insufficient credits.', code: 402, metadata: { reason: 'another_reason' } } }), null))
    expect(other.code).toBe('credits')
    expect(other.message).toBe('openrouter insufficient credits (HTTP 402, another_reason): Insufficient credits.')
    const bare = cloudError(mapHttpError('other', 402, JSON.stringify({ error: { message: 'Insufficient Balance', type: 'billing' } }), null))
    expect(bare.code).toBe('credits')
    expect(bare.message).toBe('other insufficient credits (HTTP 402): Insufficient Balance')
    expect(isFallbackable(bare) && isCreditRefusal(bare)).toBe(true)
  })

  test('a 402 body that is not the OpenAI error shape is shown raw and read as insufficient credits', () => {
    const html = cloudError(mapHttpError('openrouter', 402, '<html>Payment Required</html>', null))
    expect(html.code).toBe('credits')
    expect(html.message).toBe('openrouter insufficient credits (HTTP 402): <html>Payment Required</html>')
    const shapeless = cloudError(mapHttpError('openrouter', 402, JSON.stringify({ detail: 'pay up' }), null))
    expect(shapeless.message).toBe('openrouter insufficient credits (HTTP 402): {"detail":"pay up"}')
  })

  test('other 4xx stay bad_request', () => {
    const err = cloudError(mapHttpError('openrouter', 400, IN_FLIGHT_BODY, null))
    expect(err.code).toBe('bad_request')
    expect(isFallbackable(err)).toBe(false)
  })
})
