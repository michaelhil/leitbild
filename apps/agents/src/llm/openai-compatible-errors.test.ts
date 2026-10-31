import { describe, expect, test } from 'bun:test'
import { isExplicitCreditExhaustion, mapHttpError } from './openai-compatible-errors.ts'
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

// Actual direct OpenAI error exposed by the configured runtime on 2026-10-31.
const CREDIT_MESSAGE = 'You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.'
const CREDIT_ERROR = { message: CREDIT_MESSAGE, type: 'insufficient_quota', param: null, code: 'credit_balance_exhausted' }

describe('explicit upstream credit exhaustion', () => {
  test('the actual OpenAI 429 is credits, not a rate limit or timed backoff', () => {
    const err = cloudError(mapHttpError('openai', 429, JSON.stringify({ error: CREDIT_ERROR }), '60'))
    expect(err).toMatchObject({ code: 'credits', provider: 'openai', status: 429 })
    expect(err.message).toBe(`openai insufficient credits (HTTP 429): ${CREDIT_MESSAGE}`)
    expect(err.retryAfterMs).toBeUndefined()
    expect(isCreditRefusal(err) && isFallbackable(err)).toBe(true)
  })

  test.each([
    { message: 'Billing quota exhausted', code: 'insufficient_quota' },
    { message: 'Billing quota exhausted', type: 'insufficient_quota' },
    { message: 'Billing quota exhausted', code: null, type: 'insufficient_quota' },
    { message: 'Billing quota exhausted', metadata: { reason: 'credit_balance_exhausted' } },
    { message: CREDIT_MESSAGE, code: 502 },
  ])('only known structured billing indicators or the actual explicit sentence establish credits: %j', error => {
    expect(isExplicitCreditExhaustion(error)).toBe(true)
    expect(cloudError(mapHttpError('upstream', 502, JSON.stringify({ error }), null)).code).toBe('credits')
  })

  test.each([
    { message: 'quota exceeded' },
    { message: 'Request limit reached; add credits or retry later.' },
    { message: `Example diagnostic: ${CREDIT_MESSAGE}` },
    { message: CREDIT_MESSAGE, code: 'rate_limit_exceeded', type: 'requests' },
    { message: CREDIT_MESSAGE, code: 'context_length_exceeded' },
    { message: CREDIT_MESSAGE, type: 'rate_limit_error' },
    { message: CREDIT_MESSAGE, code: { ambiguous: true } },
    { message: CREDIT_MESSAGE, metadata: { reason: 'in_flight_budget_exhausted' } },
  ])('ambiguous prose and other named failures are not permanent credits: %j', error => {
    expect(isExplicitCreditExhaustion(error)).toBe(false)
  })

  test('real rate limits retain Retry-After; ambiguous 429 and generic 502 keep their existing routes', () => {
    const rate = cloudError(mapHttpError('openai', 429, JSON.stringify({ error: {
      message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded',
    } }), '7'))
    expect(rate).toMatchObject({ code: 'rate_limit', status: 429, retryAfterMs: 7_000 })
    expect(cloudError(mapHttpError('openai', 429, JSON.stringify({ error: { message: 'quota exceeded' } }), '9')))
      .toMatchObject({ code: 'rate_limit', retryAfterMs: 9_000 })
    expect(cloudError(mapHttpError('openrouter', 502, JSON.stringify({ error: { message: 'Upstream unavailable', code: 502 } }), '3')))
      .toMatchObject({ code: 'provider_down', status: 502, retryAfterMs: 3_000 })
    expect(cloudError(mapHttpError('openrouter', 502, CREDIT_MESSAGE, null)).code).toBe('provider_down')
  })

  test('authentication and context errors remain unchanged', () => {
    expect(cloudError(mapHttpError('openai', 401, JSON.stringify({ error: { message: CREDIT_MESSAGE, code: 'invalid_api_key' } }), null)).code).toBe('auth')
    expect(cloudError(mapHttpError('openai', 400, JSON.stringify({ error: { message: 'maximum context length exceeded', code: 'context_length_exceeded' } }), null)).code).toBe('provider_down')
  })
})

describe('mapHttpError — HTTP 402', () => {
  test('in_flight_budget_exhausted is a transient in-flight limit worded by the provider', () => {
    const err = cloudError(mapHttpError('openrouter', 402, IN_FLIGHT_BODY, null))
    expect(err.code).toBe('in_flight_limit')
    expect(err.status).toBe(402)
    expect(err.provider).toBe('openrouter')
    expect(err.message).toBe('openrouter in-flight budget exhausted (HTTP 402, in_flight_budget_exhausted): This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits.')
    expect(isFallbackable(err) && isCreditRefusal(err)).toBe(true)
    expect(isExplicitCreditExhaustion(JSON.parse(IN_FLIGHT_BODY).error)).toBe(false)
    const nullable = JSON.parse(IN_FLIGHT_BODY)
    nullable.error.code = null
    nullable.error.type = null
    expect(cloudError(mapHttpError('openrouter', 402, JSON.stringify(nullable), null)).code).toBe('in_flight_limit')
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
