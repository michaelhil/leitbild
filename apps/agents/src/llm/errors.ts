// Discriminated-union error types for the LLM layer.
// Plain objects (with Error prototype) so stack traces survive, while staying
// in functional style (no ES6 classes).

export type OllamaErrorCode = 'ollama_error'
export type GatewayErrorCode = 'circuit_open' | 'queue_full' | 'queue_timeout' | 'not_supported'
// in_flight_limit and credits are HTTP 402 answers about the provider
// account's credits (openai-compatible-errors.ts, isCreditRefusal).
export type CloudErrorCode = 'rate_limit' | 'quota' | 'auth' | 'provider_down' | 'bad_request' | 'in_flight_limit' | 'credits'

export interface OllamaError extends Error {
  readonly kind: 'ollama_error'
  readonly status: number
}

// Invalid request/protocol state is not a provider outage. Never retry it on
// another route or count it against provider health. Route refusals (see
// isRouteRefusal) are the one exception to "another route".
export interface LLMRequestError extends Error {
  readonly kind: 'request_error'
  readonly code: string
}

export const createLLMRequestError = (code: string, message: string): LLMRequestError => {
  const err = new Error(message) as LLMRequestError
  return Object.assign(err, { name: 'LLMRequestError', kind: 'request_error' as const, code })
}

export const isLLMRequestError = (err: unknown): err is LLMRequestError =>
  err instanceof Error && (err as { kind?: string }).kind === 'request_error'

// Request errors one provider route raises locally, before any network I/O,
// because that route cannot carry this request: direct OpenAI Chat
// Completions with tools at a non-none effort, an effort the route has no
// mapping for, or a context window smaller than the request. Another route
// for the same model may carry the identical request, so an unpinned router
// skips the route with a structured reason; the request is never adapted.
const ROUTE_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'unsupported_provider_transport', 'reasoning_effort_unsupported', 'context_capacity',
])

export const isRouteRefusal = (err: unknown): err is LLMRequestError =>
  isLLMRequestError(err) && ROUTE_REFUSAL_CODES.has(err.code)

export interface GatewayError extends Error {
  readonly kind: 'gateway_error'
  readonly code: GatewayErrorCode
}

export interface CloudProviderError extends Error {
  readonly kind: 'cloud_error'
  readonly code: CloudErrorCode
  readonly provider: string
  readonly status?: number
  readonly retryAfterMs?: number
}

export const createOllamaError = (status: number, message: string): OllamaError => {
  const err = new Error(message) as Error & { kind: 'ollama_error'; status: number }
  err.name = 'OllamaError'
  err.kind = 'ollama_error'
  err.status = status
  return err
}

export const createGatewayError = (code: GatewayErrorCode, message: string): GatewayError => {
  const err = new Error(message) as Error & { kind: 'gateway_error'; code: GatewayErrorCode }
  err.name = 'GatewayError'
  err.kind = 'gateway_error'
  err.code = code
  return err
}

export interface CloudProviderErrorInit {
  readonly code: CloudErrorCode
  readonly provider: string
  readonly message: string
  readonly status?: number
  readonly retryAfterMs?: number
}

export const createCloudProviderError = (init: CloudProviderErrorInit): CloudProviderError => {
  const err = new Error(init.message) as Error & {
    kind: 'cloud_error'
    code: CloudErrorCode
    provider: string
    status?: number
    retryAfterMs?: number
  }
  err.name = 'CloudProviderError'
  err.kind = 'cloud_error'
  err.code = init.code
  err.provider = init.provider
  if (init.status !== undefined) err.status = init.status
  if (init.retryAfterMs !== undefined) err.retryAfterMs = init.retryAfterMs
  return err
}

export const isOllamaError = (err: unknown): err is OllamaError =>
  err instanceof Error && (err as { kind?: string }).kind === 'ollama_error'

export const isGatewayError = (err: unknown): err is GatewayError =>
  err instanceof Error && (err as { kind?: string }).kind === 'gateway_error'

export const isCloudProviderError = (err: unknown): err is CloudProviderError =>
  err instanceof Error && (err as { kind?: string }).kind === 'cloud_error'

export const createAbortError = (message = 'The operation was aborted'): Error => {
  const err = new Error(message)
  err.name = 'AbortError'
  return err
}

// Cancellation is caller intent, not provider health. Some runtimes throw a
// DOMException while others surface a plain Error named AbortError, so the
// signal is authoritative and the name is the portable fallback.
export const isAbortError = (err: unknown, signal?: AbortSignal): boolean =>
  signal?.aborted === true || (err instanceof Error && err.name === 'AbortError')

// 4xx Ollama errors are permanent (model not found, bad request). Don't retry, don't trip circuit breaker.
export const isPermanent = (err: OllamaError): boolean =>
  err.status >= 400 && err.status < 500

// Cloud errors suitable for same-model router fallthrough. Auth and bad_request
// remain provider/request configuration errors at this layer; LLMService may
// still advance an explicit cross-provider model chain for auth isolation.
export const isFallbackable = (err: CloudProviderError): boolean =>
  err.code === 'rate_limit' || err.code === 'quota' || err.code === 'provider_down' || isCreditRefusal(err)

// HTTP 402: the provider account's credits refused this one request. Another
// route may still serve it, so the router falls through, but the monitor
// holds no cooldown. The refusal ends when the requests in flight on the
// account settle (in_flight_limit, seconds) or when a human adds credits
// (credits), neither at a time a timer knows. A cooldown would sideline the
// provider for every room past that moment, and gpt-5.4 with tools has no
// other route. The provider's next answer is the probe: a refusal returns
// quickly, and production (2026-10-10) runs OpenRouter at maxConcurrent 1,
// so it sees at most one probe at a time.
export const isCreditRefusal = (err: CloudProviderError): boolean =>
  err.code === 'in_flight_limit' || err.code === 'credits'

// Parse Retry-After header: HTTP spec allows delta-seconds (integer) or HTTP-date.
// Returns ms from now, or undefined if absent/unparseable/already-elapsed.
//
// Returning 0 for past dates would collapse the cooldown — callers use
// `err.retryAfterMs ?? defaultMs` and `0 ?? defaultMs` is `0` (the nullish
// coalesce only triggers on null/undefined). A zero cooldown causes immediate
// re-attempt on the same provider, defeating the failover. Past dates and
// zero deltas therefore map to undefined so the default cooldown applies.
export const parseRetryAfterMs = (header: string | null, now: () => number = Date.now): number | undefined => {
  if (!header) return undefined
  const trimmed = header.trim()
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10)
    if (seconds <= 0) return undefined
    return seconds * 1000
  }
  const dateMs = Date.parse(trimmed)
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - now()
    return delta > 0 ? delta : undefined
  }
  return undefined
}

// Convenience: same parse but returns seconds (rounded). Used by the embedder
// where the upstream EmbedError contract carries `retryAfterSec`. Single source
// of truth for the parse logic — divergence here was the prior duplication.
export const parseRetryAfterSeconds = (header: string | null, now: () => number = Date.now): number | null => {
  const ms = parseRetryAfterMs(header, now)
  return ms === undefined ? null : Math.round(ms / 1000)
}
