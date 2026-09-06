// ============================================================================
// OpenAI-compatible wire-format mapping.
//
// Extracted from openai-compatible.ts to isolate wire translation. Holds the
// ChatRequest ↔ OAI body translation, model-family detection (gpt-5/o-
// series quirks), multimodal content-part building, and the Anthropic
// cache-marker helper. Pure functions; no I/O.
//
// Why a sibling file (not subdir): keeps import-path churn local —
// only the parent openai-compatible.ts imports from here.
// ============================================================================

import type { ChatRequest } from '../core/types/llm.ts'
import type { ModelInfo } from '../core/types/model-info.ts'
import { createLLMRequestError } from './errors.ts'

// === OpenAI wire types ===

// Anthropic's OpenAI-compat endpoint accepts an array of content parts on a
// message, where each part can carry a `cache_control` marker. We only emit
// this shape when talking to Anthropic; other providers continue to get a
// plain string in `content`.
export interface OAIContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string; detail?: 'low' | 'high' | 'auto' }
  cache_control?: { type: 'ephemeral' }
}

export interface OAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ReadonlyArray<OAIContentPart> | null
  // Provider protocol state, carried separately from readable prompt prose.
  reasoning_content?: string
  reasoning?: string
  reasoning_details?: ReadonlyArray<Readonly<Record<string, unknown>>>
  tool_calls?: ReadonlyArray<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
}

// === Cache-marker helper ===
// Spread-clones the array AND its last entry, attaches `cache_control:
// ephemeral` to the cloned tail entry, and returns a new array. Pure and
// non-mutating — safe to use on a `ChatRequest.tools` reference shared with
// the router's failover path. Aliasing risk is the load-bearing concern
// here: an in-place mutation would leak the marker into a subsequent
// failover call to a non-Anthropic provider whose OpenAI-compat shim may
// reject the unknown field.
export const markLastCacheable = <T>(arr: ReadonlyArray<T>): T[] => {
  if (arr.length === 0) return []
  const out = [...arr]
  const tail = { ...out[out.length - 1] } as Record<string, unknown>
  tail.cache_control = { type: 'ephemeral' }
  out[out.length - 1] = tail as unknown as T
  return out
}

// === Request conversion ===

// Moonshot/Kimi rejects assistant messages with empty `content` (400
// "must not be empty"), while OpenAI/Anthropic/Gemini accept them
// (legitimate for tool-call-only turns or thinking-model responses that
// hit max_tokens during reasoning). Substitute a single space at the
// wire layer so the history round-trips without changing internal state.
// Applied to all providers — every OAI-compat target accepts " ".
export const safeAssistantContent = (m: { role: string; content: string }): string =>
  m.role === 'assistant' && (!m.content || m.content.length === 0) ? ' ' : m.content

// When a message carries images (V1 multimodal), build content parts.
// Returns null if the message has no images, signaling the caller to use
// the plain-string path. Only fires for user messages — assistant + system
// stay text-only (assistant images aren't part of the OAI flow we use;
// system prompts don't carry images).
export const messageContentWithImages = (
  m: ChatRequest['messages'][number],
): ReadonlyArray<OAIContentPart> | null => {
  if (!m.images || m.images.length === 0) return null
  if (m.role !== 'user') return null
  const parts: OAIContentPart[] = []
  if (m.content && m.content.length > 0) {
    parts.push({ type: 'text', text: m.content })
  }
  for (const img of m.images) {
    parts.push({ type: 'image_url', image_url: { url: img.dataUrl, detail: 'auto' } })
  }
  return parts
}

export const toOAIMessages = (request: ChatRequest, providerName: string): OAIMessage[] => {
  const toMessage = (m: ChatRequest['messages'][number]): OAIMessage => {
    if (m.continuation && (m.role !== 'assistant' || providerName !== m.continuation.provider || request.model !== m.continuation.model)) {
      throw createLLMRequestError('provider_continuation_route_mismatch', 'provider_continuation_route_mismatch: cannot send continuation to a different provider or model')
    }
    const withImages = messageContentWithImages(m)
    return {
      role: m.role,
      content: withImages ?? safeAssistantContent(m),
      ...(m.continuation?.reasoningDetails ? { reasoning_details: m.continuation.reasoningDetails } : {}),
      ...(m.continuation?.reasoning !== undefined ? { reasoning: m.continuation.reasoning } : {}),
      ...(m.role === 'assistant' && m.toolCalls ? { tool_calls: m.toolCalls.map((call, index) => ({
        id: call.id ?? `call_${index}`,
        type: 'function' as const,
        function: { name: call.function.name, arguments: JSON.stringify(call.function.arguments) },
      })) } : {}),
      ...(m.role === 'tool' && m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      ...(m.role === 'tool' && m.name ? { name: m.name } : {}),
    }
  }
  if (request.systemBlocks && request.systemBlocks.length > 0) {
    if (request.messages.some(message => message.role === 'system')) {
      throw new Error('ChatRequest cannot contain both systemBlocks and a system message')
    }
    const out: OAIMessage[] = []
    if (providerName === 'anthropic') {
      // Anthropic caches every token through the final marked block.
      const systemParts: OAIContentPart[] = []
      let lastCacheableIdx = -1
      for (let i = 0; i < request.systemBlocks.length; i++) {
        if (request.systemBlocks[i]!.cacheable) lastCacheableIdx = i
      }
      for (let i = 0; i < request.systemBlocks.length; i++) {
        const block = request.systemBlocks[i]!
        if (!block.text) continue
        const part: OAIContentPart = { type: 'text', text: block.text }
        if (i === lastCacheableIdx) part.cache_control = { type: 'ephemeral' }
        systemParts.push(part)
      }
      if (systemParts.length > 0) out.push({ role: 'system', content: systemParts })
    } else {
      const systemText = request.systemBlocks.map(block => block.text).filter(Boolean).join('\n\n')
      if (systemText) out.push({ role: 'system', content: systemText })
    }
    for (const message of request.messages) out.push(toMessage(message))
    return out
  }
  return request.messages.map(toMessage)
}

// === Model-family detection ===

export const stripProviderPrefix = (model: string): string => {
  const idx = model.indexOf(':')
  return idx >= 0 ? model.slice(idx + 1) : model
}

// gpt-5.x and o-series (o1, o2, …): use max_completion_tokens (not
// max_tokens) and reject temperature in the request body. These two
// quirks ship together for the same model family.
export const isNewOpenAIFamily = (model: string): boolean => {
  const id = stripProviderPrefix(model).toLowerCase()
  return /^gpt-[56](?:[.-]|$)/.test(id) || /^o[1-9]/.test(id)
}

export const usesMaxCompletionTokens = isNewOpenAIFamily
export const rejectsTemperature = isNewOpenAIFamily

// === Body builder ===

export const buildOAIBody = (request: ChatRequest, stream: boolean, providerName: string, modelInfo?: ModelInfo): Record<string, unknown> => {
  // Documented direct OpenAI Chat Completions limits, not a model allowlist
  // or an OpenRouter restriction. Do not silently drop tools/change effort.
  // https://developers.openai.com/api/docs/guides/reasoning
  // https://developers.openai.com/api/docs/guides/migrate-to-responses
  if (providerName === 'openai') {
    const id = stripProviderPrefix(request.model).toLowerCase()
    const astra = /^gpt-6-astra(?:-|$)/.test(id)
    if (astra && request.reasoningEffort === 'none') {
      throw createLLMRequestError('reasoning_effort_unsupported', 'reasoning_effort_unsupported: GPT-6 Astra does not support none reasoning effort')
    }
    const requiresNone = /^gpt-5\.[456](?:-|$)/.test(id)
    if (request.tools?.length && (astra || (requiresNone && (request.reasoningEffort ?? modelInfo?.reasoning?.defaultEffort) !== 'none'))) {
      throw createLLMRequestError('unsupported_provider_transport', astra
        ? 'unsupported_provider_transport: direct OpenAI Chat Completions does not support GPT-6 Astra function calling; use a supported route such as OpenRouter'
        : 'unsupported_provider_transport: direct OpenAI Chat Completions requires explicit none reasoning effort for this model with tools; choose none or a supported route such as OpenRouter')
    }
  }
  const body: Record<string, unknown> = {
    model: request.model,
    messages: toOAIMessages(request, providerName),
    stream,
  }
  // Ask providers to include a final usage frame (supported by OpenAI, Groq,
  // Cerebras, OpenRouter). Providers that don't support it ignore the flag.
  if (stream) body.stream_options = { include_usage: true }
  if (request.reasoningEffort !== undefined) {
    const effort = request.reasoningEffort
    const supported = modelInfo?.reasoning?.supportedEfforts
    const parameters = modelInfo?.supportedParameters
    const knownUnsupported = parameters !== undefined && !parameters.includes('reasoning') && !parameters.includes('reasoning_effort') && modelInfo?.reasoning === undefined
    if (knownUnsupported || (supported !== undefined && supported !== null && !supported.includes(effort)) || (effort === 'none' && modelInfo?.reasoning?.mandatory)) {
      throw createLLMRequestError('reasoning_effort_unsupported', `reasoning_effort_unsupported: ${providerName}/${request.model} does not accept ${effort}`)
    }
    if (providerName === 'openrouter') body.reasoning = { effort }
    else if (providerName === 'openai') body.reasoning_effort = effort
    else throw createLLMRequestError('reasoning_effort_unsupported', `reasoning_effort_unsupported: explicit reasoning effort has no supported wire mapping for ${providerName}`)
  }
  if (request.temperature !== undefined && !rejectsTemperature(request.model)) {
    body.temperature = request.temperature
  }
  // Seed is emitted to every OpenAI-shape provider. Providers that support it
  // (OpenAI, Groq, Cerebras, OpenRouter, Mistral, SambaNova) honor it; those
  // that don't (Anthropic, Gemini) silently discard unknown fields.
  if (request.seed !== undefined) body.seed = request.seed
  if (request.maxTokens !== undefined) {
    if (usesMaxCompletionTokens(request.model)) {
      body.max_completion_tokens = request.maxTokens
    } else {
      body.max_tokens = request.maxTokens
    }
  }
  if (request.jsonMode) body.response_format = { type: 'json_object' }
  if (request.tools && request.tools.length > 0) {
    // Anthropic-only: attach `cache_control: ephemeral` (top-level on the
    // last tool entry, NOT nested inside `function`). Anthropic caches
    // tools and system on separate axes, so this marker is independent of
    // the system-block marker — both are needed to cache both prefixes.
    body.tools = providerName === 'anthropic'
      ? markLastCacheable(request.tools)
      : request.tools
  }
  if (request.toolChoice !== undefined && request.tools && request.tools.length > 0) {
    if (request.toolChoice === 'auto' || request.toolChoice === 'required') {
      body.tool_choice = request.toolChoice
    } else {
      body.tool_choice = { type: 'function', function: { name: request.toolChoice.name } }
    }
  }
  return body
}
