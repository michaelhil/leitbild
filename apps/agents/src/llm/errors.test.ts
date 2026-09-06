import { describe, it, expect } from 'bun:test'
import { createLLMRequestError, isLLMRequestError, parseRetryAfterMs } from './errors.ts'
import { classifyLLMError, isAgentFallbackable } from '../agents/error-classify.ts'

describe('deterministic request/protocol errors', () => {
  it('retains its message and stays terminal even when prose contains a network-looking word', () => {
    const error = createLLMRequestError('invalid_tool_arguments', 'Invalid network target arguments; no call dispatched')
    expect(error).toBeInstanceOf(Error)
    expect(isLLMRequestError(error)).toBe(true)
    expect(error.code).toBe('invalid_tool_arguments')
    expect(classifyLLMError(error)).toEqual({ code: 'unknown', message: error.message })
    expect(isAgentFallbackable(error)).toBe(false)
    expect(isLLMRequestError(new Error(error.message))).toBe(false)
  })
})

describe('parseRetryAfterMs', () => {
  const fixedNow = (): number => 1_700_000_000_000  // 2023-11-14

  it('returns undefined for null/empty', () => {
    expect(parseRetryAfterMs(null, fixedNow)).toBeUndefined()
    expect(parseRetryAfterMs('', fixedNow)).toBeUndefined()
  })

  it('parses positive integer-seconds', () => {
    expect(parseRetryAfterMs('5', fixedNow)).toBe(5000)
    expect(parseRetryAfterMs('  10  ', fixedNow)).toBe(10_000)
  })

  it('returns undefined for zero or negative seconds (would collapse cooldown)', () => {
    expect(parseRetryAfterMs('0', fixedNow)).toBeUndefined()
    // -5 doesn't match \d+ so falls through; still undefined.
    expect(parseRetryAfterMs('-5', fixedNow)).toBeUndefined()
  })

  it('parses HTTP-date in the future', () => {
    const future = new Date(fixedNow() + 30_000).toUTCString()
    const got = parseRetryAfterMs(future, fixedNow)
    expect(got).toBeDefined()
    expect(got).toBeGreaterThan(28_000)
    expect(got).toBeLessThanOrEqual(30_000)
  })

  it('returns undefined for HTTP-date in the past (no zero-cooldown collapse)', () => {
    expect(parseRetryAfterMs('Wed, 01 Jan 2020 00:00:00 GMT', fixedNow)).toBeUndefined()
  })

  it('returns undefined for HTTP-date equal to now', () => {
    const sameNow = new Date(fixedNow()).toUTCString()
    expect(parseRetryAfterMs(sameNow, fixedNow)).toBeUndefined()
  })

  it('returns undefined for unparseable garbage', () => {
    expect(parseRetryAfterMs('not-a-date-or-int', fixedNow)).toBeUndefined()
    expect(parseRetryAfterMs('abc123', fixedNow)).toBeUndefined()
  })
})
